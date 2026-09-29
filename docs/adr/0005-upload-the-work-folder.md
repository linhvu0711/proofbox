# The Work folder is uploaded; the Sandbox never clones the repo

proofbox sends the Caller's tracked and new files (minus git-ignored ones) into the Sandbox, so no GitHub token ever enters it and uncommitted work can be checked. The proof records the commit SHA and whether the tree was dirty. After the first upload the Sandbox keeps a list of file hashes, and the next upload sends only changed and new files and removes deleted ones, so a check after a fix does not start from zero.

## Consequences

- The Sandbox has no `.git` folder. Repo scripts that look for one act differently, for example a postinstall script that skips its work when it finds no git checkout.
