# Parse rate against the hkmc2 test corpus

Measured on 2026-10-18 against every `.mls` file under
`hkmc2/shared/src/test/mlscript` and `hkmc2/shared/src/test/mlscript-compile`
of hkust-taco/mlscript at `03027b727`, which includes PR #577 (underscore
lambda shorthand and `\` trailing-argument application). A file is *clean* when
its tree has no ERROR or MISSING node.

Reproduce with:

```sh
node script/parse-rate.mjs <hkmc2>/shared/src/test/mlscript <hkmc2>/shared/src/test/mlscript-compile
```

The script uses `npx -y tree-sitter-cli@0.26.9` unless `$TS` says otherwise.
It also marks a failing file *expected* when each of its innermost errors is in
a diff-test block that the reference parser rejects as well: the block has a
`:pe` directive, or its `//│` output reports a PARSE ERROR or LEXICAL ERROR.

## Results

| Corpus | Files | Clean before | Clean after |
| --- | --- | --- | --- |
| `mlscript/**` (diff tests) | 952 | 928 (97.5%) | 941 (98.8%) |
| `mlscript-compile/**` (library and app sources) | 115 | 114 (99.1%) | 115 (100.0%) |
| **Total** | **1067** | **1042 (97.7%)** | **1056 (99.0%)** |
| Clean, or every error in a block the reference rejects | 1067 | 1051 (98.5%) | 1065 (99.8%) |

"Before" is the grammar at `a8fe868` (David Mak's latest). "After" is branch
`hkmc2-sync`.

The before figure flatters the old grammar. Before the fix, `=>` with no
parameters before it was lexed as the character operator `=>`, so lines such
as `fun f = => ...` and `xs.map(=> _ + 1)` sometimes parsed with no error but
gave the wrong tree. 38 files in the corpus get a different tree now,
including the 14 that became clean. Most of them gain a `lambda` where the old tree had an `operator`, or
take the new `\` grouping.

## What was fixed

| Failure category (before) | Files | Example | Fix |
| --- | --- | --- | --- |
| Lambda with no parameters, `=> body` (PR #577) | 12 | `syntax/CollectionTransforms.mls:33` `xs.map(=> _ + 1)` | `lambda` parameters are optional. The body can be an expression, a `{...}` record, or an indented block. |
| Definition whose `=` starts the next line, `let x` / `= 1` | 1 | `basics/NewlineOps.mls:143` | A line may start with `=`, which gives a `split_branch`, as other infix keywords already do. |
| Error recovery after an unfinished `let` / `handle` swallowing later blocks | 1 | `parser/Handler.mls:4` | During recovery the scanner turns a line break into `_newline`, so the error stops at the end of its line. Before, each later line break was another error. |

The `\` application from PR #577 caused no ERROR nodes before, because `\` was
lexed as an operator with selection precedence. It still parsed wrong, so it is
fixed too. `\` is now its own keyword in `infix_application`. It binds as
tightly as selection on its left and as loosely as a lambda body on its right,
so `xs |> f \ a + 1` is `xs |> f(a + 1)` and `f \ g \ a` is `f(g(a))`. A line
that starts with `\` is a `split_branch`. Longer runs such as `\\` are still
operators.

The recovery change also makes `basics/WeirdCalls.mls` clean. Its `:pe` block
has a closing `)` at the wrong indentation, which the reference rejects and the
grammar now tolerates. One more file is now *expected*: `fun (\) huh(x)` in
`syntax/WeirdBrackets.mls` is rejected by the reference as well.

## Remaining failures (11 files)

| Category | Files | Example |
| --- | --- | --- |
| Deliberate parse errors (`:pe` blocks the reference rejects too) | 9 | `parser/Class.mls:83`, `ups/Future.mls:90` `Rep(Rep(Char) ~ )` |
| Error recovery from a `:pe` block spilling into the next block | 2 | `basics/TryFinally.mls:30` (`42 finally ...` on one line: the misplaced `finally` makes the error cover lines 29-61); `parser/Let.mls:216` (a zero-width error after the `let` / `with` `:pe` block) |

Every remaining error comes from a block the reference rejects too, either
directly or by spilling over from one.

## Known differences in tree shape (no ERROR node)

These parse without error but group differently from the reference. They do
not change how a token is highlighted.

- Indented operator and `\` splits (`f` followed by indented lines `\ a`,
  `\ b`) become sibling `split_branch` nodes in a block. The reference builds a
  left-nested chain from them.
- `f x \ y` groups as `(f x) \ y`. Going by the reference's precedences (the
  juxtaposed argument is read at application precedence, which is lower than
  the left precedence of `\`), it should be `f (x \ y)`. This was not checked
  against the reference.
- `let x` / `= 1` gives a `let_binding` with no body followed by a
  `split_branch`, not one binding.
- `=>` with parameters is still a right-associative operator at the lambda-body
  precedence, so `a + x => b` groups differently. The new `\` rule shows that
  an exact asymmetric encoding works: the shift of an operator is decided by
  the precedence of the step before it. The same approach could be applied to
  `=>`.
- Older, unrelated issue: `s Iter.some(...)` parses as `(s Iter).some(...)`.
  The grammar's own comment says the reference gives `s (Iter.some(...))`.
