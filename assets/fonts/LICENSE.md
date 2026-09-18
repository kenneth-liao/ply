# Font licenses

Every face in this directory is an OFL 1.1–licensed TTF from the Google
Fonts collection — most are latin subsets; the two Groundline faces shipped
by #179 (Archivo, IBM Plex Mono) are the full upstream files, recorded as
such below. Fonts load through `@font-face` from these local bytes only —
the tool never fetches fonts from the network. The full licence text ships
alongside the fonts in `OFL.txt`; the per-face copyright notices required by
the licence are in the table below. SHA-256 checksums make the bytes
verifiable against upstream (github.com/google/fonts).

| File | Family | License | © | SHA-256 |
|---|---|---|---|---|
| `alegreya.ttf` | Alegreya (900) | OFL 1.1 | The Alegreya Project Authors | `c1c5d86aabe495ce23a5557b432ad4706bea187e93d6190e29b6c1157dfeac74` |
| `anton.ttf` | Anton (400) | OFL 1.1 | Vernon Adams | `3de40176cd8f890e6c8895028335f54b23272d91304e461d7dbd6bc6ff997bab` |
| `Archivo[wdth,wght].ttf` | Archivo (variable, full file — wght 100–900, wdth 62–125, default 400/100) | OFL 1.1 | The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) | `0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053` |
| `archivo-black.ttf` | Archivo Black (400) | OFL 1.1 | Omnibus-Type | `f0c361fecb86002f2204129aa77d19afb70af9fbc5259c44b0798553b942b87e` |
| `bevan.ttf` | Bevan (400) | OFL 1.1 | Vernon Adams | `4525bfd95b2e3e626b1e4a522cdb76be2c5f64009c4b78a1b9e555ab8feef187` |
| `bitter.ttf` | Bitter (700) | OFL 1.1 | Sol Matas, Huerta Tipográfica | `d62e692f21a4200906b895748a752107bc0e7e2b45030d912c5fa3f2e378941c` |
| `IBMPlexMono-Medium.ttf` | IBM Plex Mono (500, full file) | OFL 1.1 | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | `a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755` |
| `lora.ttf` | Lora (700) | OFL 1.1 | Cyreal | `57172670b89b38f392f2d055f708e6cd9d4d59156948db3b9217e2665a9b441c` |
| `marcellus.ttf` | Marcellus (400) | OFL 1.1 | Astigmatic | `4e7404f1dc1f6487d0fcdadcb19ceb099b7274ef235055bb78e751eb93e4c015` |
| `montserrat.ttf` | Montserrat (600) | OFL 1.1 | The Montserrat Project Authors | `96c43ee88af9d0379312ed086502f87f6bfebf675a6f473770d08c6dd27f2c1f` |
| `nunito-sans.ttf` | Nunito Sans (700) | OFL 1.1 | Vernon Adams, Jacques Le Bailly | `7869e9bfdf433762c066204985e2952eb4972b330fc988fb69dbc9c263df3761` |
| `oswald.ttf` | Oswald (700) | OFL 1.1 | Kalapi Gajjar, Vernon Adams | `f311bb90f5bd3771893c696250bfbecba50f3aa49e040c6b21c2564146ee98a9` |
| `passion-one.ttf` | Passion One (900) | OFL 1.1 | Eduardo Tunni | `af1545228e2d71d10718deb5998de1347b22063236d61c4ce2f394cb27fb2daf` |
| `permanent-marker.ttf` | Permanent Marker (400) | OFL 1.1 | Font Diner | `38d4690a8ea86436312da76ea3f14030a1e36026008a8c3d278a57600ca33a87` |
| `source-sans-3.ttf` | Source Sans 3 (600) | OFL 1.1 | Adobe | `7995724f073959fb0c9379db544566e91b8d9fb4df52275ac8d0b19730a8096f` |

Provenance: the thirteen pre-#179 faces were fetched 2026-08-27 via
google-webfonts-helper (`gwfh.mranftl.com`) and verified byte-identical
(SHA-256) to the latin subset files served by fonts.gstatic.com — i.e.
Google's own subset builds, not third-party re-cuts. The two #179 faces
(`Archivo[wdth,wght].ttf`, `IBMPlexMono-Medium.ttf`) are the exact full
upstream files (not subsets) pinned from google/fonts at commit
`ade3d1533e06b2b1462ffcde8e08b129627ca360`. The primary font names are
Reserved Font Names under the OFL, retained unchanged as Google serves them.
The pairing that uses each face is recorded in `src/fonts.ts`, the canonical
home for font resolution.
