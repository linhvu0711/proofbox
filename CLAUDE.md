Read `CODING_STANDARDS.md` before you write or review code.

<!-- embed-source:start -->
## Embedded library source

Full source of some dependencies lives under `repos/`. Read the real implementations and tests there instead of guessing from docs.

| lib | version | idiom files |
| --- | --- | --- |
| effect | 3.22.2 | `docs/idioms/effect-*.md` |

- `repos/` is read-only reference, outside the build and outside git. Edits there are lost on the next fetch.
- Import from the installed package, never from `repos/`.
- Start with the idiom files. They quote the shapes this project uses. Search the source with `semble search "<what it does>" repos/effect -k 5` when the idiom files do not cover a case.
- Missing `repos/effect`? Run `bash scripts/sync-repos.sh`.
- Update with `/embed-source update effect` after bumping the package. Check drift with `/embed-source check`.
<!-- embed-source:end -->
