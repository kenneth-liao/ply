# Fixture fonts (#232, spec #226 TEST-007)

Small OFL-licensed fonts committed as caller-font fixtures. They are test
inputs only — never bundled faces — and every test that uses them treats
them as caller-supplied files.

| File | Role | Source (upstream, unmodified) | sha-256 |
| --- | --- | --- | --- |
| `Silkscreen-Regular.ttf` | static face | https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf | `c845473330b94c2079ce9af01c51ac8ba2d99c24f4d14c039843bbb8e642ebd8` |
| `Handjet.ttf` | variable face (`ELGR`, `ELSH`, `wght` axes; Ply controls `wght` only) | https://raw.githubusercontent.com/google/fonts/main/ofl/handjet/Handjet%5BELGR%2CELSH%2Cwght%5D.ttf | `9262749e8bb0b73ebcae0e20428689c3c59576eebeb6c4e1020300d2d41bdf4d` |

Each font's `OFL.txt` licence sits beside it (`Silkscreen-OFL.txt`,
`Handjet-OFL.txt`). Licensing of a caller's font is the caller's concern;
these files are committed so the automated seams run offline. The files are
the exact upstream bytes — never subset.