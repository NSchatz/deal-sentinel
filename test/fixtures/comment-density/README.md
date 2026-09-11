# comment-density samples

Every sample the comment-density counter is graded against, parked under the
`.fixture` extension so the sweep over the real tree cannot read one as tree
content. `test/unit/comment-density.test.ts` hands each of them to the counter
under a synthetic `.ts` or `.tsx` path, which is what decides how it is
tokenized.

| sample | what it plants |
|---|---|
| `comment-looking-bytes.ts.fixture` | comment bytes that are not comments: a URL, a string, a template literal, two regular expression literals, a trailing comment |
| `comment-looking-jsx.tsx.fixture` | the same inside JSX, plus one real JSX comment |
| `narrated.ts.fixture` | line, block and JSDoc prose, a trailing comment, and a block opened on a code line |
| `over-the-ceiling.ts.fixture` | a file whose ratio is above the cap |
| `in-the-warn-band.ts.fixture` | a file between the committed warn floor and the committed ceiling |
| `under-the-floor.ts.fixture` | all prose, too few counted lines to be measured |
| `generated-output.ts.fixture` | the generated marker in a header |
| `unterminated-comment.ts.fixture` | a block comment with no close |
| `unterminated-string.ts.fixture` | a string literal with no close |
| `unterminated-template.ts.fixture` | a template literal with no close |
