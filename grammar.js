/**
 * @file MLscript grammar for tree-sitter
 * @author David Mak <chmakac@connect.ust.hk>
 * @license MIT
 *
 * Transcribed from the reference implementation on the `hkmc2` branch of the
 * MLscript compiler:
 *
 *   hkmc2/shared/src/main/scala/hkmc2/syntax/Lexer.scala      -- tokens, indentation
 *   hkmc2/shared/src/main/scala/hkmc2/syntax/Keyword.scala    -- keyword precedences
 *   hkmc2/shared/src/main/scala/hkmc2/syntax/Parser.scala     -- operator precedences
 *   hkmc2/shared/src/main/scala/hkmc2/syntax/ParseRule.scala  -- keyword-led constructs
 *   hkmc2/shared/src/main/scala/hkmc2/syntax/Tree.scala       -- node names
 *
 * Node names follow the `Tree` enum so the grammar can be read against the
 * reference parser.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Precedences are the reference implementation's own numbers, so they can be
// checked directly against `Keyword.scala` and `Parser.scala`.
//
// `Keyword.scala` hands out 3..21 to keyword operators. `Parser.charPrecList`
// then lays character operators on top, starting at `Keyword.maxPrec` (21):
// index i of that list has precedence i + 21.
const PREC = {
  // Keyword operators (Keyword.scala).
  EXTENDS: 3, // `extends`, `restricts`, `with`
  EQ: 4, // `=`, and the right precedence of `then` / `do` / `:` / `->`
  THEN: 6, // `then`, `do`, `drop`
  WHERE: 7, // `where`, and `return` / `throw` / `yield` / `import`
  IN: 8, // `in`, `out`
  KW_PIPE: 9, // `|`
  KW_AMP: 10, // `&`
  LAM_RHS: 11, // right precedence of `=>`
  OR: 12,
  AND: 13,
  IS_RHS: 15, // right precedence of `is`
  AS: 16,
  COLON: 17,
  NOT: 19, // right precedence of `not`
  IS: 20,
  ARROW: 21, // left precedence of `->`; also Keyword.maxPrec
  ANNOT_BODY: 22, // Parser.AnnotBodyPrec (`Keyword.maxPrec + 1`)

  // Character operators (Parser.charPrecList, offset by Keyword.maxPrec).
  OP_SEMI: 23,
  OP_AT: 24,
  OP_COLON: 25,
  OP_PIPE: 26,
  OP_AMP: 27,
  OP_EQ: 28,
  OP_CARET: 29,
  OP_BANG: 30,
  OP_CMP: 31,
  OP_ADD: 32,
  OP_MUL: 33,
  OP_TILDE: 34,

  PREFIX: 36, // Parser.PrefixOpsPrec
  APP: 37, // Parser.AppPrec
  SEL: 38, // Parser.SelPrec, and the right precedence of `new`
  HASH: 39, // Keyword.hashSelPrec, and the left precedence of `=>`
  // The left precedence of `\` (`Keyword.backslash`): that of selection.
  BACKSLASH: 38,
};

// `symbolicIdentifierChars` from hkmc2/package.scala, plus `.` -- together they
// are `Lexer.isOpChar`.
const SYM_CHARS = '!#%&*+\\-/:<=>?@\\\\^|~.';

/** An operator token: a first character from `first`, then any run of symbolic
 * characters. `Parser.opPrec` takes an operator's precedence from its first
 * character, which is what these tiers encode.
 *
 * Each tier is split into a one-character token and a longer one. They are
 * disjoint, so the lexer never has to break a tie between them, and the split
 * lets `unary_expression` accept only the one-character form: `Parser.prefixOps`
 * is a set of exact strings, so `-x` is a prefix application but `--x` is the
 * operator `--` juxtaposed with `x`. */
function operatorRules() {
  const rules = {};
  for (const [key, , first, one] of OPERATOR_TIERS) {
    rules['_op_' + key + '_one'] = _ => new RegExp('[' + (one ?? first) + ']');
    rules['_op_' + key + '_many'] = _ => new RegExp('[' + first + '][' + SYM_CHARS + ']+');
  }
  return rules;
}

/** Both tokens of a tier, as an `operator` node. */
function operatorToken($, key) {
  return choice(
    alias($['_op_' + key + '_one'], $.operator),
    alias($['_op_' + key + '_many'], $.operator),
  );
}

/** Only the one-character token of a tier, for `Parser.prefixOps`. */
function prefixOperatorToken($, key) {
  return alias($['_op_' + key + '_one'], $.operator);
}

/** The right-hand side of an operator that carries a precedence.
 *
 * It has to be written inline rather than through a named rule: a named wrapper
 * such as `_body` puts a zero-precedence reduction between the operand and the
 * operator that follows it, and a zero-precedence reduce always loses to the
 * shift -- which silently flattens every binary operator into right nesting,
 * making `a * b + c` parse as `a * (b + c)`. A single supertype (`_expression`)
 * is fine; it is the extra level that breaks it. */
function operand($) {
  return choice($._expression, $.block, $._keyword_operand);
}

/** The same operator, quoted: `` a `+ b ``. `Parser.exprCont` matches the QUOTE
 * and the operator as adjacent tokens, with no space between them, so they are
 * lexed together here -- which also lets the operator's precedence be known as
 * soon as the backtick is seen. */
function quotedOperatorToken(first) {
  return new RegExp('`[' + first + '][' + SYM_CHARS + ']*');
}

// Character-operator tiers, keyed on the first character. An optional fourth
// element narrows the first characters of the tier's one-character token. Note that `=`, `:`,
// `|`, `&`, `#`, `->`, `=>`, `..` and `...` are *keywords* rather than
// operators (they are registered in `Keyword.all`, so `Parser.OP` rejects
// them); they are written as string literals below, which tree-sitter prefers
// over an equal-length pattern match.
const OPERATOR_TIERS = [
  ['semi', PREC.OP_SEMI, ';'],
  ['at', PREC.OP_AT, '@'],
  ['colon', PREC.OP_COLON, ':'],
  ['pipe', PREC.OP_PIPE, '|'],
  ['amp', PREC.OP_AMP, '&'],
  ['eq', PREC.OP_EQ, '='],
  ['caret', PREC.OP_CARET, '\\^'],
  ['bang', PREC.OP_BANG, '!'],
  ['cmp', PREC.OP_CMP, '<>'],
  ['add', PREC.OP_ADD, '+\\-'],
  ['mul', PREC.OP_MUL, '*/%'],
  ['tilde', PREC.OP_TILDE, '~'],
  // A lone `\` is `Keyword.backslash` rather than an operator, so the
  // one-character token of this tier is `.` alone; longer runs such as `\\`
  // stay operators.
  ['dot', PREC.SEL, '.\\\\', '.'],
  // `?` and `#` are absent from `charPrecList`, so `Parser.precOf` falls back to
  // `Int.MaxValue` for them: tighter than every listed operator. (Bare `#` is a
  // keyword and is written as a literal elsewhere; a longer operator such as
  // `##` or `#:` is not.)
  ['other', PREC.HASH, '?#'],
];

// Keyword infix operators, from `ParseRules.infixRules` with the precedences
// declared in `Keyword.scala`. A keyword whose right precedence is at least its
// left precedence associates to the left, because the reference parser's
// precedence climbing test is strict (`leftPrec > minPrec`).
const INFIX_KEYWORDS = [
  ['extends', PREC.EXTENDS, PREC.EXTENDS],
  ['restricts', PREC.EXTENDS, PREC.EXTENDS],
  ['with', PREC.EXTENDS, PREC.EXTENDS],
  ['then', PREC.THEN, PREC.EQ],
  ['where', PREC.WHERE, PREC.WHERE],
  ['|', PREC.KW_PIPE, PREC.KW_PIPE],
  ['&', PREC.KW_AMP, PREC.KW_AMP],
  ['or', PREC.OR, PREC.OR],
  ['and', PREC.AND, PREC.AND + 1],
  ['as', PREC.AS, PREC.AS],
  [':', PREC.COLON, PREC.EQ],
  ['is', PREC.IS, PREC.IS_RHS],
];

/** Modifiers accepted before a declaration (`Keyword.modifiers`, plus the
 * variance and staging markers that `ParseRules` treats the same way). */
const MODIFIERS = [
  'abstract',
  'data',
  'declare',
  'mut',
  'out',
  'override',
  'private',
  'public',
  'staged',
  'virtual',
];

export default grammar({
  name: 'mlscript',

  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
    $.difftest_directive,
    $._select_dot,
    $._error_sentinel,
  ],

  extras: $ => [
    /[ \t\r]/,
    $.comment,
    $.difftest_output,
    $.difftest_directive,
  ],

  word: $ => $._word,

  supertypes: $ => [$._expression, $._statement, $._literal],

  conflicts: $ => [
    [$.handle_binding, $.handle_in_binding],
    // A modifier keyword is also a usable name (`class Bind(name, data, tail)`),
    // and which one it is only becomes clear further along the line.
    [$.identifier, $.modifier],
  ],

  rules: {
    // A stray indented block is a statement in its own right: the reference
    // makes it a `Block` (an indented comment-only line after a directive is
    // the common case), so it is accepted wherever statements are.
    source_file: $ => repeat($._block_item),

    _block_item: $ => choice($._statement, $._separator, $.block),

    // The per-tier operator tokens (see `operatorRules`).
    ...operatorRules(),

    _separator: $ => choice($._newline, ','),

    // ------------------------------------------------------------------
    // Statements
    // ------------------------------------------------------------------

    _statement: $ => choice(
      $.fun_definition,
      $.val_definition,
      $.let_binding,
      $.set_binding,
      $.class_definition,
      $.trait_definition,
      $.module_definition,
      $.object_definition,
      $.mixin_definition,
      $.type_definition,
      $.pattern_definition,
      $.import_statement,
      $.open_statement,
      $.annotated,
      $.handle_binding,
      $.handle_in_binding,
      $.definition,
      $.split_branch,
      $._expression,
    ),

    // Ambiguous with `identifier` (see `conflicts`): when both parses survive,
    // the dynamic precedence picks the modifier, so `data class Foo` is a
    // declaration and only `f(a, data, c)` -- where the modifier parse dies --
    // falls back to the plain name.
    modifier: $ => prec.dynamic(1, choice(...MODIFIERS)),

    // `Tree.OpSplit`. Inside an indented block a branch may start with the
    // operator itself, sharing the left operand with its siblings:
    //
    //     if c
    //       === "(" then 0
    //       === "=" then 1
    //
    // The reference re-roots each branch on the shared left-hand side; here the
    // branches are left as siblings, so the operand grouping inside a branch is
    // flatter than the reference's tree.
    split_branch: $ => prec.right(1, choice(
      // A keyword branch may put its body on the following line, which
      // `Parser.exprCont` accepts for any keyword with `canStartInfixOnNewLine`:
      //
      //     if
      //       true
      //       and
      //       true do print("ok")
      //
      // `\` and `=` qualify too, the latter for a definition whose `=` starts
      // the next line (`let x` / `= 1`); the branch is then a sibling of the
      // binding rather than its body.
      seq(
        field('operator', choice(...INFIX_KEYWORDS.map(([op]) => op), '\\', '=')),
        repeat($._newline),
        field('right', operand($)),
      ),
      // A character operator does not: a line holding nothing but `+` is the
      // operator itself (`Parsed: Ident(+)` in `parser/Operators.mls`).
      seq(
        field('operator', choice(
          ...OPERATOR_TIERS.map(([key]) => operatorToken($, key)),
        )),
        field('right', operand($)),
      ),
    )),

    // `Tree.Def`: a bare `lhs = rhs`, which the reference builds in
    // `Parser.blockOfImpl` at block level only -- `=` is not a general infix
    // operator. Named arguments such as `f(x = 1)` are the same construct,
    // because bracketed sections are parsed as blocks.
    definition: $ => prec.right(PREC.EQ, seq(
      field('left', $._expression),
      '=',
      field('right', $._body),
    )),

    // `Tree.TermDef`
    fun_definition: $ => prec.right(seq(
      repeat($.modifier),
      'fun',
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
    )),

    val_definition: $ => prec.right(seq(
      repeat($.modifier),
      choice('val', 'using'),
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
    )),

    // `Tree.LetLike`
    let_binding: $ => prec.right(seq(
      'let',
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
      optional(seq('in', field('in', $._body))),
    )),

    set_binding: $ => prec.right(seq(
      'set',
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
      optional(seq('in', field('in', $._body))),
    )),

    // `Tree.TypeDef`. The reference's `typeDeclBody` parses a single expression
    // for the whole head, so inherited clauses (`extends`, `with`) and the body
    // arrive as infix applications or as a juxtaposed indented block.
    class_definition: $ => seq(repeat($.modifier), 'class', field('head', $._definition_head)),
    trait_definition: $ => seq(repeat($.modifier), 'trait', field('head', $._definition_head)),
    module_definition: $ => seq(repeat($.modifier), 'module', field('head', $._definition_head)),
    object_definition: $ => seq(repeat($.modifier), 'object', field('head', $._definition_head)),
    mixin_definition: $ => seq(repeat($.modifier), 'mixin', field('head', $._definition_head)),

    // `typeAliasLike`
    type_definition: $ => prec.right(seq(
      repeat($.modifier),
      'type',
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
    )),

    pattern_definition: $ => prec.right(seq(
      repeat($.modifier),
      'pattern',
      field('head', $._definition_head),
      optional(seq('=', field('body', $._body))),
    )),

    // A declaration head is an ordinary expression; it is kept as its own rule
    // so the `=` that follows is never mistaken for the `definition` operator.
    _definition_head: $ => choice(
      $._expression,
      $.block,
    ),

    // `Tree.Open` / the `import` prefix rule.
    import_statement: $ => prec.right(PREC.WHERE, seq('import', field('path', $._body))),
    open_statement: $ => prec.right(PREC.IS, seq('open', field('module', $._body))),

    // ------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------

    _expression: $ => choice(
      $.identifier,
      $._literal,
      $.wildcard,
      $.this_expression,
      $.super_expression,
      $.suspension,
      $.parenthesized_expression,
      $.tuple,
      $.record,
      $.type_arguments,
      $.application,
      $.of_application,
      $.juxtaposition,
      $.juxtaposed_block,
      $.refinement,
      $.selection,
      $.if_expression,
      $.while_expression,
      $.case_expression,
      $.new_expression,
      $.lambda,
      $.function_type,
      $.infix_application,
      $.prefix_application,
      $.unary_expression,
      $.modified_expression,
      $.constructor_definition,
      $.directive,
      $.operator,
      $.quoted,
      $.quoted_let,
      $.quoted_if,
      $.quoted_infix,
      $.quoted_application,
      $.pun,
      $.escaped_identifier,
      $.leading_selection,
      $.member_projection,
      $.region_expression,
      $.try_expression,
      $.outer_expression,
      $.assert_expression,
    ),

    // The bindings `Parser.expr` reaches through
    // `prefixRulesAllowIndentedBlock`, which is why `... then set acc = 1` and
    // `module Foo with val x = 1` parse. This one *is* a named rule: it never
    // sits on the `_expression` path, so it cannot interpose the
    // zero-precedence reduction that `operand` exists to avoid.
    _keyword_operand: $ => choice(
      $.fun_definition,
      $.val_definition,
      $.let_binding,
      $.set_binding,
    ),

    // The right-hand side of a binding or a keyword operator is either an
    // expression or an indented block (`ParseRules.exprOrBlk`).
    // `ParseRules.exprOrBlk`. The reference reads the right-hand side with
    // `expr`, which goes through `prefixRulesAllowIndentedBlock` -- the same
    // rule set as a block item -- so keyword-led forms are allowed here too:
    // `fun reset() = set steps = 0`.
    _body: $ => choice($._statement, $.block),

    block: $ => seq(
      $._indent,
      repeat($._block_item),
      $._dedent,
    ),

    // `Tree.Bra(Round, _)` and `Tree.Unt`. Bracketed sections are parsed as
    // blocks, which is what allows `f(x = 1)` and multi-line argument lists.
    parenthesized_expression: $ => seq('(', optional($._bracket_body), ')'),

    // `Tree.Tup`
    tuple: $ => seq('[', optional($._bracket_body), ']'),

    // `Tree.Bra(Curly, _)`
    record: $ => seq('{', optional($._bracket_body), '}'),

    _block_items: $ => repeat1($._block_item),

    _bracket_body: $ => choice($.operator_identifier, $._block_items),

    // A *keyword* operator used as a name, as in `fun (=>) f(a, b)`. The
    // symbolic operators reach the same position through `operator`, which is a
    // plain expression; only the keywords need this escape hatch.
    operator_identifier: $ => choice('|', '&', ':', '=', '->', '=>', '#'),

    // `Parser.simpleExprImpl` turns any symbolic identifier that is not a
    // keyword into a plain `Tree.Ident`, so an operator is an ordinary
    // expression: `???`, `f(+)`, `new mut ::(x, xs)`, `folded of 1, *`.
    operator: $ => choice(
      ...OPERATOR_TIERS.map(([key]) => choice($['_op_' + key + '_one'], $['_op_' + key + '_many'])),
    ),

    // A `[...]` section directly after an expression: type arguments or a
    // subscript. Kept distinct from `tuple` so highlighting can tell them apart.
    type_arguments: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      token.immediate('['),
      optional($._bracket_body),
      ']',
    )),

    // `Tree.App`
    application: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      field('arguments', $.arguments),
    )),

    arguments: $ => seq('(', optional($._bracket_body), ')'),

    // `f of a, b` -- `Keyword.of` is applied at `Parser.AppPrec`. The reference
    // reads the arguments with `blockMaybeIndented`, so they form a whole
    // block: commas separate them, the list may continue on an indented line,
    // and it may even start on the next (unindented) line, which
    // `Parser.maybeIndented` accepts with a warning.
    of_application: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      'of',
      optional($._newline),
      field('arguments', $.of_arguments),
    )),

    // The comma list is `prec.right` so that a trailing comma keeps the list
    // open rather than closing the application.
    of_arguments: $ => prec.right(seq(
      operand($),
      repeat(seq(',', optional($._newline), operand($))),
    )),

    // `Tree.Jux`: `f x`. The reference only juxtaposes when the right operand
    // starts with a plain (non-keyword) identifier.
    juxtaposition: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      field('argument', $._jux_operand),
    )),

    // Restricted to a bare identifier: the reference only starts a
    // juxtaposition when the next token is a non-keyword alphanumeric
    // identifier, and any trailing selection or application then binds tighter
    // than the juxtaposition itself, so `f x.y` is `Jux(f, Sel(x, y))`.
    _jux_operand: $ => $.identifier,

    // `Tree.Jux` with an indented block, as in a class body written without
    // `with`.
    juxtaposed_block: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      field('body', $.block),
    )),

    // `Tree.Reft`: `Foo { ... }`
    refinement: $ => prec.left(PREC.APP, seq(
      field('base', $._expression),
      field('body', $.record),
    )),

    // `Tree.Sel` / `Tree.DynAccess`. The reference lexes `.name` and `!name` as
    // a single SELECT token, so no space is allowed on either side of the dot.
    selection: $ => prec.left(PREC.SEL, seq(
      field('object', $._expression),
      $._select_dot,
      field('field', alias($._immediate_name, $.identifier)),
    )),

    _immediate_name: $ => token.immediate(/[\p{L}_'][\p{L}\p{Nd}_']*|[0-9]+/u),

    // `Tree.IfLike`
    if_expression: $ => prec.right(seq(
      'if',
      field('condition', $._body),
      optional(seq('else', field('alternative', $._body))),
    )),

    while_expression: $ => prec.right(seq(
      'while',
      field('condition', $._body),
      optional(seq('else', field('alternative', $._body))),
    )),

    // `Tree.Case`
    case_expression: $ => prec.right(seq('case', field('branches', $._body))),

    // `Tree.LexicalNew`. `new` binds at `SelPrec`, so `new C(1)` is
    // `(new C)(1)` and `new A.B` is `new (A.B)`. `new C(1) with <block>` is
    // thus an infix `with`, as in the reference, whose `Tree.desugared` folds
    // it into the same `ProperNew` as `new C with <block>`.
    new_expression: $ => choice(
      prec.right(PREC.SEL, seq(
        choice('new', 'new!'),
        optional(field('constructor', $._expression)),
      )),
      // `ParseRules`' `withRefinement`: `new with <block>` and
      // `new C with <block>` build a `LexicalNew` carrying a refinement body.
      // The body uses `operand` so that this `with` and the infix one draw on
      // the same symbols.
      prec.right(PREC.SEL, seq(
        choice('new', 'new!'),
        optional(field('constructor', $._new_constructor)),
        'with',
        field('body', operand($)),
      )),
    ),

    // The constructor of a `new ... with`. After `new C`, the shift of `with`
    // would be weighed against the infix `with` (`C with ...`, precedence
    // `EXTENDS`) as well as against the reduction of a bare `new C`, and the
    // lower infix precedence makes the reduction win. Reducing the constructor
    // to this symbol first, at a precedence above that of `new_expression`,
    // takes the infix item out of the state that shifts `with`.
    _new_constructor: $ => prec(PREC.HASH, $._expression),

    // `x => e`. The reference gives `=>` a very tight left precedence and a very
    // loose right one; tree-sitter cannot express that asymmetry, so this is a
    // right-associative operator at the `=>` right precedence, which agrees with
    // the reference on everything except pathological mixtures such as
    // `a + x => b`.
    //
    // The parameters may be left out (`Keyword.Prefix` includes `=>`): `=> e`
    // is a lambda whose parameters are the `_` placeholders of its body, as in
    // `xs.map(=> _ + 1)` or `=> { x: _, y: _ }`.
    lambda: $ => prec.right(PREC.LAM_RHS, seq(
      optional(field('parameters', $._expression)),
      '=>',
      repeat($._newline),
      field('body', operand($)),
    )),

    // `A -> B`
    function_type: $ => prec.right(PREC.EQ, seq(
      field('parameter', $._expression),
      '->',
      repeat($._newline),
      field('result', operand($)),
    )),

    // `Tree.InfixApp`
    infix_application: $ => choice(
      ...INFIX_KEYWORDS.map(([op, left, right]) =>
        (right >= left ? prec.left : prec.right)(left, seq(
          field('left', $._expression),
          field('operator', op),
          repeat($._newline),
          field('right', operand($)),
        ))),
      // A line may end on a dangling operator and continue on the next one.
      // `Parser.maybeIndented` accepts this even when the continuation is not
      // indented (it only warns), so the newline is optional here.
      ...OPERATOR_TIERS.map(([key, prec_]) =>
        prec.left(prec_, seq(
          field('left', $._expression),
          field('operator', operatorToken($, key)),
          repeat($._newline),
          field('right', operand($)),
        ))),
      // `f \ a` means `f(a)` and `f(x) \ a` means `f(x, a)`
      // (`Keyword.backslash`). The keyword binds as tightly as selection on
      // the left but as loosely as a lambda body on the right, so
      // `xs |> f \ a + 1` is `xs |> f(a + 1)` and `f \ g \ a` is `f(g(a))`.
      // Unlike `=>`, the asymmetry is expressed exactly: tree-sitter resolves
      // the shift of `\` with the precedence of the step before it (the left
      // operand), and the reduction of the whole application with that of its
      // last step. The inner `prec` must cover the operator too, because
      // leaving a `prec` resets its last step to the enclosing precedence.
      prec.right(PREC.LAM_RHS, seq(
        prec(PREC.BACKSLASH, seq(
          field('left', $._expression),
          field('operator', '\\'),
        )),
        repeat($._newline),
        field('right', operand($)),
      )),
      prec.left(PREC.HASH, seq(
        field('left', $._expression),
        field('operator', '#'),
        field('right', $._expression),
      )),
    ),

    // `Tree.PrefixApp` for the keyword prefixes of `Keyword.Prefix`.
    prefix_application: $ => choice(
      prec.right(PREC.NOT, seq(field('operator', 'not'), field('operand', operand($)))),
      prec.right(PREC.EQ, seq(field('operator', choice('do', 'else', 'drop')), field('operand', operand($)))),
      prec.right(PREC.WHERE, seq(
        field('operator', choice('return', 'throw', 'yield', 'yield*')),
        field('operand', operand($)),
      )),
      prec.right(PREC.WHERE, 'return'),
    ),

    // Prefix character operators (`Parser.prefixOps`). Each takes its
    // precedence from `opCharPrec` of its first character, except `!`, which
    // the reference pins at `PrefixOpsPrec`.
    unary_expression: $ => choice(
      prec.right(PREC.PREFIX, seq(field('operator', prefixOperatorToken($, 'bang')), field('operand', $._expression))),
      prec.right(PREC.OP_ADD, seq(field('operator', prefixOperatorToken($, 'add')), field('operand', $._expression))),
      prec.right(PREC.OP_TILDE, seq(field('operator', prefixOperatorToken($, 'tilde')), field('operand', $._expression))),
      prec.right(PREC.OP_AT, seq(field('operator', prefixOperatorToken($, 'at')), field('operand', $._expression))),
      prec.right(PREC.KW_PIPE, seq(field('operator', '|'), field('operand', $._expression))),
      prec.right(PREC.KW_AMP, seq(field('operator', '&'), field('operand', $._expression))),
    ),

    // `Tree.Modified`: `mut x`, `out T`, and the other modifier keywords used
    // in expression position rather than in front of a declaration.
    // The body may be an indented block, in which case the reference re-applies
    // the modifier to every line of it (`Parser.parseRuleImpl`), as in
    // `data` / `class` / declarations written across three levels.
    // The body is deliberately *not* `$._body`: a modifier in front of a
    // declaration is already carried by that declaration's own
    // `repeat($.modifier)`, and letting both paths match would make the tree
    // for `data class Foo` ambiguous.
    modified_expression: $ => prec.right(PREC.SEL, seq(
      field('modifier', $.modifier),
      field('body', choice($._expression, $.block)),
    )),

    // `Tree.Constructor`
    constructor_definition: $ => prec.right(seq('constructor', optional(field('body', $._body)))),

    // `#config(...)` and friends -- `Tree.Directive`.
    directive: $ => prec.right(PREC.HASH, seq('#', field('name', $._expression))),

    // ------------------------------------------------------------------
    // Keyword-led constructs (`ParseRules.prefixRules`)
    // ------------------------------------------------------------------

    // `Tree.Hndl`: `handle h = E with <block>`, optionally scoped over a body
    // by a trailing `in` clause.
    //
    // The two forms are separate rules with a declared conflict: the handler
    // block has already closed by the time the `in` is read, so the parser sees
    // only a newline and cannot tell one from the other with a single token of
    // lookahead.
    handle_binding: $ => seq(
      'handle',
      field('name', $._expression),
      '=',
      field('class', $._expression),
      'with',
      field('body', operand($)),
    ),

    handle_in_binding: $ => seq(
      'handle',
      field('name', $._expression),
      '=',
      field('class', $._expression),
      'with',
      field('body', operand($)),
      repeat($._newline),
      'in',
      field('in', $._body),
    ),

    // `Tree.Region`: `region r in <body>`
    region_expression: $ => prec.right(seq(
      'region',
      field('name', $._expression),
      'in',
      field('body', $._body),
    )),

    // `Tree.TryFinally`. The `finally` sits at the same indentation as the
    // `try`, so the body's block has already closed by the time it is read.
    try_expression: $ => prec.right(seq(
      'try',
      field('body', $._body),
      repeat($._newline),
      'finally',
      field('finalizer', $._body),
    )),

    // `Tree.Outer`: `outer` on its own, or `outer name`.
    outer_expression: $ => prec.right(seq('outer', optional(field('name', $._expression)))),

    // `assert e else d`
    assert_expression: $ => prec.right(seq(
      'assert',
      field('condition', $._body),
      optional(seq('else', field('alternative', $._body))),
    )),

    // ------------------------------------------------------------------
    // Annotations, puns and escaped names
    // ------------------------------------------------------------------

    // `Tree.Annotated`. `Parser.annot` reads the annotation at `SelPrec` with
    // `gobbleSpaces = false`, so it stops at the first space: `@foo (2 + 2)`
    // annotates `(2 + 2)` instead of calling `foo`.
    annotated: $ => prec.right(PREC.ANNOT_BODY, seq(
      repeat1(field('annotation', $.annotation)),
      // An annotation is usually written on its own line above what it
      // annotates.
      repeat($._newline),
      field('target', choice($._statement, $.block)),
    )),

    annotation: $ => seq(
      field('name', $.annotation_name),
      optional(field('arguments', alias($._immediate_arguments, $.arguments))),
    ),

    annotation_name: $ => token(seq(
      '@',
      /[\p{L}_'][\p{L}\p{Nd}_']*/u,
      repeat(seq('.', /[\p{L}_'][\p{L}\p{Nd}_']*/u)),
    )),

    _immediate_arguments: $ => seq(token.immediate('('), optional($._bracket_body), ')'),

    // `Tree.Pun`: `f(:x)` and `f(=x)`. The name must follow the marker with no
    // space, and puns only start an expression -- `a : b` is still an infix
    // type ascription.
    pun: $ => seq(
      field('operator', choice('=', ':')),
      field('name', alias($._immediate_identifier, $.identifier)),
    ),

    // The `id"..."` escape from `Lexer.lex`, which spells an identifier that
    // would not otherwise lex as one.
    escaped_identifier: $ => token(seq('id"', /[\p{L}\p{Nd}_'$]*/u, '"')),

    // `Sel(Empty, name)`: a selection with no left operand, as in `let z = .a`.
    leading_selection: $ => prec.right(PREC.SEL, seq(
      $._select_dot,
      field('field', alias($._immediate_name, $.identifier)),
    )),

    // `Tree.MemberProj`: `Cls::member`. The reference requires the name to
    // follow `::` immediately -- with a space it is the ordinary `::` operator.
    // The operator is the shared `:`-tier token rather than a `::` literal,
    // because a literal would win the lexer's tie-break against that token and
    // stop `1 :: 2 :: Nil` from parsing at all; the cost is that a projection
    // is also accepted after any other `:`-led operator.
    member_projection: $ => prec.left(PREC.OP_COLON, seq(
      field('object', $._expression),
      field('operator', operatorToken($, 'colon')),
      field('member', alias($._immediate_identifier, $.identifier)),
    )),

    _immediate_identifier: $ => token.immediate(/[\p{L}_'][\p{L}\p{Nd}_']*/u),

    // ------------------------------------------------------------------
    // Quasiquotes (`Tree.Quoted` / `Tree.Unquoted`)
    // ------------------------------------------------------------------

    // A backtick lifts the following atom into code. `Parser.simpleExprImpl`
    // accepts any identifier or literal after the QUOTE token, so `` `while ``
    // is `Quoted(Ident("while"))` rather than a quoted loop.
    quoted: $ => prec.right(PREC.SEL, seq(
      '`',
      field('body', choice($.identifier, $._literal, $.operator, $.wildcard)),
    )),

    // `` `let x = 42, y = 1 `in body ``. `Parser.bindings` takes a bare
    // identifier on the left of each `=`, and the list is comma-separated.
    quoted_let: $ => prec.right(seq(
      '`', 'let',
      field('bindings', $.quoted_bindings),
      '`', 'in',
      field('body', $._body),
    )),

    quoted_bindings: $ => seq($.quoted_binding, repeat(seq(',', $.quoted_binding))),

    quoted_binding: $ => seq(
      field('name', $.identifier),
      '=',
      field('value', $._expression),
    ),

    // `` `if c then a else b ``. Only the `if` is quoted: the reference reads
    // the condition with `simpleExprImpl`, so `then` and `else` are the plain
    // keywords.
    quoted_if: $ => prec.right(seq(
      '`', 'if',
      field('condition', $._body),
      optional(seq('else', field('alternative', $._body))),
    )),

    // `` a `+ b ``, `` x `=> e ``, `` a `-> b ``. The operator keeps the
    // precedence it would have unquoted (`Parser.exprCont`'s QUOTE branch
    // reuses `opPrec`).
    quoted_infix: $ => choice(
      ...OPERATOR_TIERS.map(([, prec_, first]) =>
        prec.left(prec_, seq(
          field('left', $._expression),
          field('operator', alias(quotedOperatorToken(first), $.quoted_operator)),
          field('right', operand($)),
        ))),
      prec.right(PREC.LAM_RHS, seq(
        field('left', $._expression),
        field('operator', alias('`=>', $.quoted_operator)),
        field('right', operand($)),
      )),
      prec.right(PREC.EQ, seq(
        field('left', $._expression),
        field('operator', alias('`->', $.quoted_operator)),
        field('right', operand($)),
      )),
    ),

    // `` f`(x) `` -- a quoted application. The backtick and the opening
    // parenthesis are adjacent in the reference too.
    quoted_application: $ => prec.left(PREC.APP, seq(
      field('function', $._expression),
      field('arguments', $.quoted_arguments),
    )),

    quoted_arguments: $ => seq('`(', optional($._bracket_body), ')'),

    // ------------------------------------------------------------------
    // Terminals
    // ------------------------------------------------------------------

    this_expression: $ => 'this',
    super_expression: $ => 'super',
    wildcard: $ => '_',

    // `Tree.Spread` / the SUSPENSION token. The operand is optional so that a
    // bare `...` body, as in `module M with ...`, still parses.
    suspension: $ => prec.right(seq(choice('...', '..'), optional($._expression))),

    // `Lexer.isIdentFirstChar` / `isIdentChar`, plus the Scala-style symbolic
    // suffix that `Lexer.takeIdent` allows after a trailing `_`.
    //
    // The modifier keywords are also accepted here. They are keywords in the
    // reference -- `data` in `f(a, data, c)` is `Modified(data, ...)` there --
    // but they read as ordinary names all over the compiler's own sources
    // (`class Bind(name: Str, data: Data, tail: Context)`), so an editor
    // grammar is more useful accepting both.
    identifier: $ => choice($._word, ...MODIFIERS),

    _word: $ => token(choice(
      // `Lexer.takeIdent` only picks up a symbolic suffix when the alphanumeric
      // part ends in `_`, so `foo_<:<` is one identifier but `head: A` is an
      // identifier followed by the `:` keyword.
      seq(/[\p{L}_'][\p{L}\p{Nd}_']*_/u, new RegExp('[' + SYM_CHARS + ']+')),
      /[\p{L}_'][\p{L}\p{Nd}_']*/u,
    )),

    _literal: $ => choice(
      $.integer_literal,
      $.decimal_literal,
      $.string_literal,
      $.boolean_literal,
      $.unit_literal,
    ),

    // `Lexer.num`: `_` is allowed as a digit separator throughout.
    integer_literal: $ => token(choice(
      /0[xX][0-9a-fA-F][0-9a-fA-F_]*/,
      /0[oO][0-7][0-7_]*/,
      /0[bB][01][01_]*/,
      /[0-9][0-9_]*/,
    )),

    decimal_literal: $ => token(choice(
      /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+\-]?[0-9][0-9_]*)?/,
      /[0-9][0-9_]*[eE][+\-]?[0-9][0-9_]*/,
    )),

    boolean_literal: $ => choice('true', 'false'),
    unit_literal: $ => choice('null', 'undefined'),

    // The character runs are `token.immediate` so that nothing in `extras` can
    // be matched inside a string -- without that, the `//` in a URL starts a
    // comment.
    string_literal: $ => choice(
      seq(
        '"""',
        repeat(choice($.escape_sequence, token.immediate(/([^"\\]|"[^"]|""[^"])+/))),
        token.immediate('"""'),
      ),
      seq(
        '"',
        repeat(choice($.escape_sequence, token.immediate(/[^"\\\n]+/))),
        token.immediate('"'),
      ),
    ),

    escape_sequence: $ => token.immediate(seq('\\', choice(
      /u[0-9a-fA-F]{4}/,
      /u\{[0-9a-fA-F]{1,6}\}/,
      /x[0-9a-fA-F]{2}/,
      /./,
    ))),

    // `//`, and the `/* */` form the reference lexer treats as non-nesting.
    comment: $ => token(prec(1, choice(
      seq('//', /[^\n]*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    ))),

    // Diff-test scaffolding. These lines are consumed by the test harness
    // (`hkmc2DiffTests/.../DiffMaker.scala`) before the source reaches the
    // lexer, so they are not MLscript syntax -- but they make up most of the
    // `.mls` files in the compiler repository, and the VS Code extension
    // highlights them, so they are recognised here as trivia.
    difftest_output: $ => token(prec(2, seq('//\u2502', /[^\n]*/))),
  },
});
