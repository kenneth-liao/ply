# Gateway charges — #315 rebuild

Every figure is the Gateway's own per-request receipt
(`run.cost`, basis `actual-charge`) from the published Job record, copied
from `logs/jobs/<job>.json`. Nothing here comes from a price table. All Jobs
ran on 2026-09-25 (UTC 2026-09-26) through `ply generate`.

| Job | Thumbnail and element | Model | Quality | Refs | Size | Outputs | Receipt (USD) |
|---|---|---|---|---|---|---|---|
| `e1-desk` | t1 desk and laptop plate | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.010925 |
| `e1-frame` | t1 neon MUST TRY frame, on black | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.005035 |
| `e1-wire` | t1 light wire, on black | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.010585 |
| `e2-mark` | t2 decorative fictional "S" mark, on black | gpt-image-2.5-flare | default | 0 | 1024x1024 | 1 | 0.006155 |
| `e2-mic` | t2 podcast mic, isolated (matted locally) | gpt-image-2.5-flare | default | 0 | 1024x1024 | 1 | 0.006315 |
| `e2-panel` | t2 flat app screenshot (put in perspective by Ply) | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.018735 |
| `e2-studio` | t2 studio plate | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.005170 |
| `e3-beams` | t3 light beams, on black | gpt-image-2.5-flare | default | 0 | 1024x1024 | 1 | 0.006180 |
| `e4-contours` | t4 contour lines, on black | gpt-image-2.5-flare | default | 0 | 1024x1024 | 1 | 0.013375 |
| `e5-holo` | t5 holographic head, on black | gpt-image-2.5-flare | default | 0 | 1024x1024 | 1 | 0.006145 |
| `e5-office` | t5 office plate | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.018315 |
| `e6-maze` | t6 maze plate | gpt-image-2.5-flare | default | 0 | 1536x1024 | 1 | 0.018285 |
| `e7-vial` | t7 vial, isolated (matted locally) | gpt-image-2.5-flare | default | 0 | 1024x1536 | 1 | 0.010790 |
| `l3-v1` | t3 likeness, first candidate pair | gpt-image-2.5-flare | low | 3 | 1536x1024 | 2 | 0.061558 |
| `l3-v2` | t3 likeness, retry 1 | gpt-image-2.5-flare | low | 3 | 1536x1024 | 2 | 0.049114 |
| `l3-v3` | t3 likeness, retry 2 (selected) | gpt-image-2.5-flare | low | 3 | 1536x1024 | 2 | 0.049704 |
| `l6-v1` | t6 likeness (selected) | gpt-image-2.5-flare | low | 3 | 1536x1024 | 2 | 0.061988 |
| `l7-v1` | t7 likeness (selected) | gpt-image-2.5-flare | low | 1 | 1536x1024 | 2 | 0.027144 |

| | USD |
|---|---|
| 13 element Jobs, 13 images | 0.136010 |
| 5 likeness Jobs, 10 images | 0.249508 |
| **Total, 18 Jobs, 23 images** | **0.385518** |

Matting (4 passes) and everything else ran locally, at no charge. Reference
images are billed as extra input tokens, as #270 found: each three-Reference
likeness Job cost 1.8 to 2.3 times the one-Reference `l7-v1`.
