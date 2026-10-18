# tree-sitter-mlscript

A [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for
[MLscript](https://github.com/hkust-taco/mlscript).

The grammar is transcribed from the reference implementation on the `hkmc2`
branch of the MLscript compiler:

| Reference source | What it contributes |
| --- | --- |
| `hkmc2/shared/src/main/scala/hkmc2/syntax/Lexer.scala` | tokens, indentation, comments |
| `hkmc2/shared/src/main/scala/hkmc2/syntax/Keyword.scala` | keyword operators and their precedences |
| `hkmc2/shared/src/main/scala/hkmc2/syntax/Parser.scala` | character-operator precedences, application and juxtaposition |
| `hkmc2/shared/src/main/scala/hkmc2/syntax/ParseRule.scala` | keyword-led constructs |
| `hkmc2/shared/src/main/scala/hkmc2/syntax/Tree.scala` | node names |

Node names follow the `Tree` enum, and precedence constants keep the reference's
own numbering, so `grammar.js` can be read side by side with the compiler.

## Layout

```
grammar.js              the grammar
src/scanner.c           external scanner: indentation, selection lookahead
queries/highlights.scm  syntax highlighting
test/corpus/            tree-sitter test cases (declarations, expressions,
                        keyword constructs, quasiquotes)
script/parse-corpus.sh  parse a directory of .mls files and report failures
```

## Indentation

MLscript is indentation sensitive, so `src/scanner.c` supplies `_indent`,
`_dedent` and `_newline`, reproducing the `case '\n'` branch of `Lexer.lex`: a
run of blank lines and spaces is consumed as a whole, every stack entry deeper
than the new column is popped before the trailing newline is emitted, and a line
indented past what remains re-opens a level.

The scanner also decides where a selection starts. The reference lexes `.name`
as a single `SELECT` token, so a `.` only begins a selection when the very next
character starts an identifier or a number — which is why `args.[idx]` and
`NoFreeze."foo"()` treat `.` as an ordinary operator instead. That needs one
character of lookahead, which a tree-sitter token cannot express.

## Coverage

The grammar covers the syntax the `hkmc2` parser accepts: declarations and
bindings, control flow, `handle` / `region` / `try`…`finally`, literals,
operators (including a bare operator used as a value), field selection and
dynamic access, type-argument lists, annotations, puns, escaped `id"..."` names,
quasiquotes, comments, and the diff-test scaffolding (`:flags` and `//│`
output lines) that fills the compiler's test files.

Measured with `script/parse-rate.mjs` (see `docs/hkmc2-parse-rate.md`):

| Corpus | Files | Parse without errors |
| --- | --- | --- |
| `mlscript-compile/**` (library and app sources) | 115 | 115 (100.0%) |
| `mlscript/**` (diff tests, unmodified) | 952 | 941 (98.8%) |
| **Total** | **1067** | **1056 (99.0%)** |

Nine of the eleven remaining failures sit directly under an expect-parse-error
marker (`:pe`) or a block whose output reports a parse error. They are the
compiler's own tests for syntax it rejects too. The other two are error
recovery spilling out of such a block into the next one.

### Not yet supported

* An `=` on the line after its binding head, as in `let x` / `= 1`. The
  reference accepts this as a newline-operator continuation. Allowing a newline
  there makes a binding head greedy across statement boundaries and costs far
  more than it buys -- it took the diff-test corpus down twelve points.
* A bare `lhs = rhs` on the right of an operator, as in `... then foo = 0`.
  Bindings introduced by `fun` / `val` / `let` / `set` do work there; `Def` does
  not, because it starts with an expression and putting it on that path
  reintroduces the precedence problem described below.
* `code"..."` quasiquote brackets and `${...}` / `$name` unquotes. `Lexer.scala`
  lexes them, but `Parser.scala` has no rule for the resulting brackets and
  answers every such form with `unsupportedQuote`, so the reference cannot parse
  them either. Backtick quasiquotes — `` `1 ``, `` a `+ b ``, `` f`(x) ``,
  `` `let … `in ``, `` `if … then … else `` — *are* supported.
* Angle-bracket sections (`A‹B›`, and the `>>`-splitting that
  `Lexer.scala` does for `A<B<C>>`). No source file in the compiler uses them.
* `Tree.RegRef` — the reference turns `r.ref v` into a region reference by
  special-casing a selection named `ref`; here it stays an ordinary selection.

### Known approximations

* An operator's right-hand side has to be written as an inline `choice` rather
  than through a named rule. A named wrapper puts a zero-precedence reduction
  between an operand and the operator that follows it, and a zero-precedence
  reduce always loses to the shift -- which silently flattens every binary
  operator into right nesting, so that `a * b + c` parses as `a * (b + c)`.
  A single supertype (`_expression`) is fine; it is the extra level that breaks
  it. `grammar.js`'s `operand` helper exists for this, and
  `test/corpus/expressions.txt` pins the grouping.
* An `if`'s `then` branch sits inside its `condition` field, as the right operand
  of the `then` infix application. The reference instead makes the `then` and
  `else` branches siblings of a block under `IfLike`. The same holds for
  `` `if ``.
* Character-operator precedence is taken from the operator's first character, as
  `Parser.opPrec` does, but every tier is left-associative; the reference derives
  associativity from the *last* character too, so `a <= b <= c` groups
  differently there.
* `=>` has a very tight left precedence and a very loose right one in the
  reference. Tree-sitter cannot express that asymmetry, so lambdas are plain
  right-associative operators; this differs only on mixtures like `a + x => b`.
* Operator splits keep their branches as siblings rather than re-rooting each on
  the shared left operand.
* The modifier keywords (`abstract`, `data`, `declare`, `mut`, `out`,
  `override`, `private`, `public`, `staged`, `virtual`) are also accepted as
  ordinary names. They are reserved in `Keyword.scala`, so `f(a, data, c)` is
  `Modified(data, …)` in the reference — but they read as plain names throughout
  the compiler's own sources (`class Bind(name: Str, data: Data, tail: Context)`),
  and an editor grammar is more useful accepting both. Which one applies is
  resolved by a dynamic precedence that prefers the modifier wherever it fits.
* A declaration carries its modifiers directly (`class_definition` has a
  `modifier` child) instead of nesting inside a `Modified` node, so there is one
  tree shape for `data class Foo` rather than two.
* `member_projection` (`Cls::mem`) is spelled with the shared `:`-tier operator
  token rather than a `::` literal, because a literal would win the lexer's
  tie-break and stop `1 :: 2 :: Nil` from parsing. A projection is therefore also
  accepted after any other `:`-led operator.
* `new C(1) with <block>` attaches the `with` as an ordinary infix application,
  the same shape as `class C with <block>`; only the bare `new with <block>`
  uses `new_expression`'s own body field.

## Development

```sh
npm install
npx tree-sitter generate
npx tree-sitter test
./script/parse-corpus.sh path/to/mlscript/**/*.mls
```

Two things to know about regenerating:

* `tree-sitter generate` rewrites `src/tree_sitter/array.h` with the installed
  CLI's copy of that runtime header. The change has nothing to do with the
  grammar; leave it out of commits.
* The generated parser is large -- around 10,900 states -- because MLscript
  puts declarations and bindings wherever an expression can go, so most operand
  positions reach the whole statement grammar. `generate` takes a couple of
  minutes and the resulting `src/parser.c` is tens of megabytes.
