#include "tree_sitter/parser.h"

#include <stdlib.h>

#include <string.h>

// External tokens produced by this scanner.
//
// MLscript is indentation sensitive. This scanner reproduces the indentation
// handling of the reference lexer in `hkmc2/shared/src/main/scala/hkmc2/syntax/Lexer.scala`
// (the `case '\n'` branch of `Lexer.lex`):
//
//   * a run of spaces and newlines is consumed as a whole, so blank lines are
//     transparent and the indentation of a line is the column of its first
//     non-space character;
//   * if the new indentation is strictly greater than the top of the indent
//     stack (and non-zero) an INDENT is produced;
//   * otherwise every stack entry strictly greater than the new indentation is
//     popped, producing one DEDENT each, and then a single INDENT (if the new
//     indentation still opens a level) or NEWLINE is produced.
//
// The reference emits the DEDENTs *before* the trailing INDENT/NEWLINE, and so
// do we.
enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
  DIFFTEST_DIRECTIVE,
  SELECT_DOT,
  ERROR_SENTINEL,
};

// The reference lexer keeps an unbounded indent stack. 256 levels is far beyond
// anything that occurs in practice and keeps the serialized state well within
// TREE_SITTER_SERIALIZATION_BUFFER_SIZE.
#define MAX_INDENTS 256

typedef struct {
  uint16_t indents[MAX_INDENTS];
  uint8_t count;
} Scanner;

void *tree_sitter_mlscript_external_scanner_create(void) {
  Scanner *scanner = (Scanner *)calloc(1, sizeof(Scanner));
  return scanner;
}

void tree_sitter_mlscript_external_scanner_destroy(void *payload) {
  free((Scanner *)payload);
}

unsigned tree_sitter_mlscript_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = (Scanner *)payload;
  unsigned size = 0;
  buffer[size++] = (char)scanner->count;
  for (unsigned i = 0; i < scanner->count; i++) {
    buffer[size++] = (char)(scanner->indents[i] & 0xFF);
    buffer[size++] = (char)((scanner->indents[i] >> 8) & 0xFF);
  }
  return size;
}

void tree_sitter_mlscript_external_scanner_deserialize(void *payload, const char *buffer,
                                                       unsigned length) {
  Scanner *scanner = (Scanner *)payload;
  scanner->count = 0;
  memset(scanner->indents, 0, sizeof(scanner->indents));
  if (length == 0) return;

  unsigned size = 0;
  uint8_t declared = (uint8_t)buffer[size++];
  uint8_t restored = 0;
  for (unsigned i = 0; i < declared && size + 1 < length; i++) {
    uint16_t lo = (uint8_t)buffer[size++];
    uint16_t hi = (uint8_t)buffer[size++];
    scanner->indents[i] = (uint16_t)(lo | (hi << 8));
    restored++;
  }
  // Trust what was actually read rather than the declared count, so a truncated
  // buffer cannot leave stale entries on the indent stack.
  scanner->count = restored;
}

static inline uint16_t top_indent(Scanner *scanner) {
  return scanner->count == 0 ? 0 : scanner->indents[scanner->count - 1];
}

static inline void push_indent(Scanner *scanner, uint16_t column) {
  if (scanner->count < MAX_INDENTS) scanner->indents[scanner->count++] = column;
}

static inline void pop_indent(Scanner *scanner) {
  if (scanner->count > 0) scanner->count--;
}

// Number of stack entries strictly greater than `column`, i.e. how many levels
// the reference lexer's `ind.dropWhile(_ > nextInd)` would drop.
static inline unsigned dropped_levels(Scanner *scanner, uint16_t column) {
  unsigned dropped = 0;
  while (dropped < scanner->count && scanner->indents[scanner->count - 1 - dropped] > column) {
    dropped++;
  }
  return dropped;
}

// `Lexer.isIdentFirstChar`, approximated: anything non-ASCII is treated as a
// letter, which matches `Character.isLetter` for every character that occurs in
// practice.
static inline bool is_ident_start(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '\'' || c >= 128;
}

static inline bool is_digit(int32_t c) { return c >= '0' && c <= '9'; }

static inline bool is_closing_bracket(int32_t c) {
  return c == ')' || c == ']' || c == '}';
}

bool tree_sitter_mlscript_external_scanner_scan(void *payload, TSLexer *lexer,
                                                const bool *valid_symbols) {
  Scanner *scanner = (Scanner *)payload;

  // In error recovery tree-sitter marks every token valid, including the
  // sentinel. Producing zero-width tokens there only compounds the damage.
  //
  // A line break is the exception: the internal lexer cannot match `\n` (it
  // is not an extra), so without a NEWLINE here every line break inside the
  // error is an error of its own, and an unfinished `let` or `handle` at the
  // end of a diff-test block swallows the blocks after it. Consuming the run as
  // a NEWLINE gives recovery a statement boundary to resynchronise on. The
  // indentation stack is left alone; the next real token sorts it out.
  if (valid_symbols[ERROR_SENTINEL]) {
    bool found_newline = false;
    while (lexer->lookahead == '\n' || lexer->lookahead == ' ' ||
           lexer->lookahead == '\t' || lexer->lookahead == '\r') {
      if (lexer->lookahead == '\n') found_newline = true;
      lexer->advance(lexer, true);
    }
    if (found_newline && !lexer->eof(lexer) &&
        lexer->get_column(lexer) <= top_indent(scanner)) {
      lexer->mark_end(lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }
    return false;
  }

  // Diff-test directive lines such as `:todo` or `:expect 1`. The test harness
  // in `hkmc2DiffTests/.../DiffMaker.scala` consumes any line starting with `:`
  // before the source reaches the lexer, so these are trivia rather than
  // MLscript syntax. They only ever occur at the start of a line.
  if (valid_symbols[DIFFTEST_DIRECTIVE] && lexer->lookahead == ':' &&
      lexer->get_column(lexer) == 0) {
    while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
      lexer->advance(lexer, false);
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = DIFFTEST_DIRECTIVE;
    return true;
  }

  // The reference lexer emits a single SELECT token for `.name` / `!name`
  // (`Lexer.lex`, the `isOpChar` branch): a `.` only starts a selection when the
  // very next character begins an identifier or a number, so `args.[idx]` and
  // `NoFreeze."foo"` lex `.` as an ordinary operator instead. Deciding that
  // needs one character of lookahead, which a tree-sitter token cannot express.
  if (valid_symbols[SELECT_DOT]) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      lexer->advance(lexer, true);
    }
    if (lexer->lookahead == '.' || lexer->lookahead == '!') {
      lexer->advance(lexer, false);
      if (is_ident_start(lexer->lookahead) || is_digit(lexer->lookahead)) {
        lexer->mark_end(lexer);
        lexer->result_symbol = SELECT_DOT;
        return true;
      }
      // The `.` belongs to a longer operator, or to a subscript such as
      // `args.[idx]`. Returning false rewinds it for the internal lexer.
      return false;
    }
    // Not a selector; fall through to the indentation handling below.
  }

  // Every token this scanner emits is either zero-width (DEDENT) or consumes the
  // whitespace run (INDENT / NEWLINE). Marking the end up front makes DEDENT
  // zero-width, so a later call re-examines the same whitespace with a shorter
  // indent stack and emits the next token of the sequence.
  lexer->mark_end(lexer);

  bool found_newline = false;
  for (;;) {
    if (lexer->lookahead == '\n') {
      found_newline = true;
      lexer->advance(lexer, true);
    } else if (lexer->lookahead == ' ' || lexer->lookahead == '\r' || lexer->lookahead == '\t') {
      lexer->advance(lexer, true);
    } else {
      break;
    }
  }

  // End of file: close every open block so the tree is well formed, mirroring
  // the way `Lexer.bracketedTokens` closes unclosed `Indent` brackets.
  if (lexer->eof(lexer)) {
    if (valid_symbols[DEDENT] && scanner->count > 0) {
      pop_indent(scanner);
      lexer->result_symbol = DEDENT;
      return true;
    }
    // A file that ends in a newline still terminates its last statement.
    if (found_newline && valid_symbols[NEWLINE]) {
      lexer->mark_end(lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }
    return false;
  }

  if (!found_newline) {
    // A block opened inside a bracketed section is closed by the bracket rather
    // than by a dedented line, as in `f(1,\n  2)`. The reference reconciles this
    // with the `swallowedInd` machinery in `Lexer.bracketedTokens`; here it is
    // enough to emit a DEDENT whenever the parser is still expecting one and the
    // section is about to close. Once the parser has closed every block it
    // opened, DEDENT stops being valid and the bracket is consumed normally.
    if (valid_symbols[DEDENT] && scanner->count > 0 && is_closing_bracket(lexer->lookahead)) {
      pop_indent(scanner);
      lexer->result_symbol = DEDENT;
      return true;
    }
    return false;
  }

  uint16_t column = (uint16_t)lexer->get_column(lexer);

  // Opening a deeper level.
  if (column > top_indent(scanner) && column > 0) {
    if (valid_symbols[INDENT]) {
      push_indent(scanner, column);
      lexer->mark_end(lexer);
      lexer->result_symbol = INDENT;
      return true;
    }
    // The parser cannot open a block here, so the line is a continuation of the
    // current one; `Parser.maybeIndented` treats it the same way.
    return false;
  }

  // Closing levels: one DEDENT per call, all of them before the trailing
  // NEWLINE/INDENT.
  if (dropped_levels(scanner, column) > 0) {
    if (!valid_symbols[DEDENT]) return false;
    pop_indent(scanner);
    lexer->result_symbol = DEDENT;
    return true;
  }

  // `hasNewIndent`: the reference re-opens a level when the line is indented
  // past what remains on the stack, even if that level was never seen before.
  if (column > top_indent(scanner) && column > 0 && valid_symbols[INDENT]) {
    push_indent(scanner, column);
    lexer->mark_end(lexer);
    lexer->result_symbol = INDENT;
    return true;
  }

  if (valid_symbols[NEWLINE]) {
    lexer->mark_end(lexer);
    lexer->result_symbol = NEWLINE;
    return true;
  }

  return false;
}
