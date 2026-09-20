# Fixture fonts (#232, spec #226 TEST-007)

Small OFL-licensed fonts committed as caller-font fixtures. They are test
inputs only — never bundled faces — and every test that uses them treats
them as caller-supplied files.

| File | Role | Source (official upstream repository, unmodified bytes) | sha-256 |
| --- | --- | --- | --- |
| `Silkscreen-Regular.ttf` | static face (TrueType) | https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf | `c845473330b94c2079ce9af01c51ac8ba2d99c24f4d14c039843bbb8e642ebd8` |
| `Silkscreen-Regular.otf` | static face, CFF OpenType (OTTO) — the same upstream project's `.otf` build, exercising the OpenType half of the format minimum (#232 review INT-parser-1) | https://github.com/googlefonts/silkscreen/raw/main/fonts/otf/Silkscreen-Regular.otf | `bee0e945d9a66ca819e67bd9e7b1b09235d2550130b12db0440c719fc6b8f82b` |
| `Handjet.ttf` | variable face (`ELGR`, `ELSH`, `wght` axes; Ply controls `wght` only) | https://raw.githubusercontent.com/google/fonts/main/ofl/handjet/Handjet%5BELGR%2CELSH%2Cwght%5D.ttf | `9262749e8bb0b73ebcae0e20428689c3c59576eebeb6c4e1020300d2d41bdf4d` |

Each font's `OFL.txt` licence sits beside it (`Silkscreen-OFL.txt`,
`Silkscreen-Otf-OFL.txt`, `Handjet-OFL.txt`). Licensing of a caller's font
is the caller's concern; these files are committed so the automated seams
run offline. The files are the exact upstream bytes — never subset.