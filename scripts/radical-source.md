# Where the `radical` column comes from

The canon reserves a `radical` field. This is the record of which source fills it,
what that source's licence actually says, and what the three rejected candidates
turned out to be licensed under.

**Chosen: the Unicode Character Database 17.0.0** — `kRSUnicode` from
`Unihan_IRGSources.txt` for the radical assignment, `CJKRadicals.txt` for the
radical number → character mapping. Under **UNICODE LICENSE V3**, which is
permissive, not copyleft, and therefore the only candidate that can be mixed
into a CC BY-SA 4.0 corpus without relicensing it.

Every quotation below was fetched and verified on 2026-08-24; the digests are
reproduced from files hashed locally, not copied from a third party.

---

## Verdicts

| Candidate | Has radical data? | Licence | Verdict |
|---|---|---|---|
| Unicode Unihan `kRSUnicode` + `CJKRadicals.txt` | Yes, 102,998 characters | UNICODE LICENSE V3 (permissive) | **Used** |
| CC-CEDICT (already vendored) | **No** | CC BY-SA 4.0 | Confirmed unusable — no such field exists |
| cjkvi-ids / CHISE IDS | No (IDS decomposition ≠ radical) | GPL-2.0-or-later | Rejected twice over |
| make-me-a-hanzi | Yes, 9,574 characters | **LGPL-3.0**-or-later (not Arphic) | Rejected: copyleft, one-way incompatible |

---

## 1. Unicode Unihan — chosen

### The licence

The data files carry only a pointer. Verbatim header of `CJKRadicals.txt`:

```
# CJKRadicals-17.0.0.txt
# Date: 2025-05-07
# © 2025 Unicode®, Inc.
# Unicode and the Unicode Logo are registered trademarks of Unicode, Inc. in the U.S. and other countries.
# For terms of use and license, see https://www.unicode.org/terms_of_use.html
```

<https://www.unicode.org/terms_of_use.html> resolves that pointer for everything
under `https://www.unicode.org/Public/`:

> All Unicode Data Files and Unicode Software are subject to the terms and
> conditions of the free and open-source Unicode License v3, unless otherwise
> indicated by specific restriction, permission, or license identified at the
> point of release or in such software, data file, or other documentation.

The operative grant, verbatim from <https://www.unicode.org/license.txt>
(sha256 `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96`):

> Permission is hereby granted, free of charge, to any person obtaining a
> copy of data files and any associated documentation (the "Data Files") or
> software and any associated documentation (the "Software") to deal in the
> Data Files or Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, and/or sell
> copies of the Data Files or Software, and to permit persons to whom the
> Data Files or Software are furnished to do so, provided that either (a)
> this copyright and permission notice appear with all copies of the Data
> Files or Software, or (b) this copyright and permission notice appear in
> associated Documentation.

and the one restriction beyond that:

> Except as contained in this notice, the name of a copyright holder shall
> not be used in advertising or otherwise to promote the sale, use or other
> dealings in these Data Files or Software without prior written
> authorization of the copyright holder.

**Redistribution of derived data is permitted.** The grant names `modify` and
`distribute` explicitly and attaches no condition to the derivative beyond the
notice. The notice requirement is satisfiable in documentation — clause (b) —
so it does not have to be stamped into every emitted file; `data/radicals.json`
carries it in its `license.attribution` array anyway, and `NOTICE` should carry
the full licence text.

**Not copyleft.** UNICODE LICENSE V3 is MIT/BSD-family. It imposes no
ShareAlike and no reciprocal licensing, so the derived radical mapping can be
redistributed as part of this repo's CC BY-SA 4.0 data set. Both notices
coexist: Unicode's travels with the radical data, CC BY-SA 4.0 governs the
corpus as a whole.

### Files, pinned

Pinned to `17.0.0`, not `/latest/`, so the next Unicode release cannot silently
change a build. Digests verified by downloading and hashing locally:

| File | Bytes | sha256 |
|---|---|---|
| `https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip` | 8,518,517 | `f7a48b2b545acfaa77b2d607ae28747404ce02baefee16396c5d2d7a8ef34b5e` |
| ↳ member `Unihan_IRGSources.txt` | 13,352,717 | `d1c817dd7db84295dab0643c277d97c2fa742c245f8824e6736c2a0935095325` |
| `https://www.unicode.org/Public/17.0.0/ucd/CJKRadicals.txt` | 5,491 | `826f83be25cd18fb8a5015a514704504e1982e840ea14d058bf583e1cc620c83` |

`kRSUnicode` lives in `Unihan_IRGSources.txt`, **not** in the invitingly-named
`Unihan_RadicalStrokeCounts.txt`, which holds only `kRSAdobe_Japan1_6`.

Vendored, because 8.1 MB of zip and 13.4 MB of text is too much to put in every
clone for one field:

| Vendored file | Bytes | What it is |
|---|---|---|
| `scripts/unihan-radicals.tsv` | 1,100,072 | `character<TAB>kRSUnicode`, 102,998 lines, reduced from the IRG member |
| `scripts/cjk-radicals.txt` | 5,491 | `CJKRadicals.txt` verbatim, byte-identical to upstream |

Regenerate both with `npm run radicals:fetch`. It refuses to write unless the
downloads hash to the pins above, so the reduction is re-derivable byte for
byte. `npm run build:radicals` then emits `data/radicals.json` with no network
access at all.

### `kRSUnicode` syntax

Per [UAX #38](https://www.unicode.org/reports/tr38/), syntax
`[1-9]\d{0,2}\'{0,3}\.-?\d{1,2}`, described as:

> The standard radical-stroke count for this ideograph in the form
> "radical.additional strokes." The radical is indicated by a number in the
> range 1–214, followed by an optional single apostrophe (U+0027 ' APOSTROPHE),
> double apostrophe (''), or triple apostrophe (''') suffix. A single apostrophe
> after the radical indicates a Chinese simplified version of the given radical.

Four things bite anyone who guesses:

1. **The apostrophes are part of the radical.** `149'` is 讠, not 言, and it has
   its own row in `CJKRadicals.txt`. 245 canon headwords use `149'` alone;
   19 apostrophe-suffixed radicals appear in the corpus. Stripping the
   apostrophe gives the wrong radical for over a thousand headwords.
2. **The simplified variants are not in the KangXi Radicals block.** They live
   in CJK Radicals Supplement (`U+2E80..U+2EF3`), so a computed
   `0x2EFF + number` mapping is wrong. `CJKRadicals.txt` is read, never computed.
3. **Residual stroke counts can be negative** (`47.-1`, `125.-2`), because a few
   ideographs are built by removing strokes from a radical. A `\d+` regex fails.
4. **`kRSKangXi` no longer exists.** UAX #38 lists it under "Properties Removed"
   as of Unicode 15.1.0. Do not target it.

A character may carry several space-separated values when it is reasonably
classifiable under more than one radical; the first is the standard one, and
that is the one taken.

---

## 2. CC-CEDICT — confirmed to carry no radicals

Verified against the vendored dump itself, not the documentation. Every entry in
`scripts/cedict.json` (v1, 2025-11-29, 124,139 entries across 120,400 headword
keys) has exactly five fields, and the same five across all of them:

```
t   traditional
s   simplified
p   tone-marked pinyin
pn  numbered pinyin
d   glosses
```

That matches the upstream format spec at <https://cc-cedict.org/wiki/syntax>,
which defines a line as
`Traditional Simplified [pin1 yin1] /gloss; gloss; .../gloss; gloss; .../`
and nothing else. Four fields. There is no radical field, no Kangxi radical
field, and no component or decomposition field, in V1 or in
<https://cc-cedict.org/wiki/syntax_v2>.

Grepping CC-CEDICT for "radical" *does* return hits — but they are glosses
*about* radicals, on the ~200 radical characters themselves, e.g.
`⺮ ⺮ [zhu2] /"bamboo" radical in Chinese characters (Kangxi radical 118)/`.
They describe those headwords; they assign nothing to the other 124,000 entries.
Not a usable source.

Licence, from the distributed file's own header (the wiki page still says 3.0
and is stale — cite the file):

```
# License:
# Creative Commons Attribution-ShareAlike 4.0 International License
# https://creativecommons.org/licenses/by-sa/4.0/
```

---

## 3. cjkvi-ids / CHISE IDS — rejected twice over

**It does not contain radical assignments.** `ids.txt` is three columns —
codepoint, character, IDS decomposition:

```
U+4F60	你	⿰亻尔
U+597D	好	⿰女子
```

An IDS is a *structural* decomposition: which components, in what geometric
arrangement. That is a different thing from a Kangxi radical assignment, and it
does not determine one — 好 decomposes to ⿰女子, and nothing in that string says
its radical is 女 (38) rather than 子 (39).

**And the licence is GPL.** The repo ships no `LICENSE` file; `README.md`
states:

> * 'ids.txt' is derived from [CHISE project](http://www.chise.org/). License
>   follows their terms. 'ids-ext-cde.txt' is not directly based on
>   [CHISE project](http://www.chise.org/), and is not restricted to GPLv2
>   license.
>
> * All other data are distributed uner GPLv2.

(`sic`.) Upstream CHISE, `README.md` at <https://github.com/chise/ids>:

> This package is free software; you can redistribute it and/or modify
> it under the terms of the GNU General Public License as published by
> the Free Software Foundation; either version 2, or (at your option)
> any later version.

GPL-2.0 is copyleft and is not on Creative Commons' compatibility list in either
direction. See §5.

---

## 4. make-me-a-hanzi — the Arphic worry is a red herring; LGPL-3.0 is the blocker

Worth stating precisely, because the obvious suspicion is the wrong one.

The repo splits its data across two licences. `COPYING`, verbatim:

> `dictionary.txt` is derived from: Unihan …, CJKlib …
>
> You can redistribute and/or modify dictionary.txt under the terms of the GNU
> Lesser General Public License as published by the Free Software Foundation,
> either version 3 of the license, or (at your option) any later version.
>
> `graphics.txt` is derived from: Arphic PL KaitiM GB …, Arphic PL UKai …
>
> You can redistribute and/or modify graphics.txt under the terms of the Arphic
> Public License as published by Arphic Technology Co., Ltd.

**The `radical` field is in `dictionary.txt`.** Verified — line 1 of that file:

```json
{"character":"⺀","definition":"ice","pinyin":[],"decomposition":"？","radical":"⺀","matches":[null,null]}
```

So using it does **not** trigger the Arphic font copyleft. Arphic covers
`graphics.txt` (stroke outlines) and `svgs.tar.gz`, and its own §0 scopes it to
"the TrueType fonts … and the derivatives of those fonts created through any
modification including modifying glyph, reordering glyph, converting format,
changing font name, or adding/deleting some characters in/from glyph table" — a
radical index is not a derivative of a glyph outline.

It is rejected anyway, for three reasons:

1. **LGPL-3.0 is one-way incompatible with CC BY-SA 4.0** (§5). Pulling the
   field in would force the derived corpus to LGPL-3.0.
2. **9,574 records**, against Unihan's 102,998.
3. **Its `radical` is a bare character with no radical number**, so a
   radical-ordered pack could not be built from it without a second source.

And its data is itself derived from Unihan — the repo's `LGPL` file opens by
reproducing the Unicode notice. Going to the source removes a licence layer
rather than adding one.

---

## 5. Why copyleft candidates were disqualified

Creative Commons lists exactly two licences as compatible with CC BY-SA 4.0 —
Free Art License 1.3 and GPLv3 — and states the direction at
<https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses/>:

> compatibility with the GPLv3 is one-way only, which means you may license your
> contributions to adaptations of BY-SA 4.0 materials under GPLv3, but you may
> not license your contributions to adaptations of GPLv3 projects under BY-SA 4.0

BY-SA 4.0 → GPLv3 is allowed. GPL → BY-SA 4.0 is not, which rules out cjkvi-ids
(GPL-2.0, not even on the list) and make-me-a-hanzi (LGPL-3.0). A permissive
source has no such problem, which is what settles it in Unicode's favour.

---

## What the build emits

`npm run build:radicals` writes `data/radicals.json` (243 KB):

```jsonc
{
  "schema": "zhongdex/radicals/v1",
  "license": { "data": "Unicode-3.0", "attribution": [ /* the Unicode notice */ ] },
  "unicodeVersion": "17.0.0",
  "inputs": [ /* six entries, each with sha256 and bytes */ ],
  "characters": 4122,
  "distinctRadicals": 230,
  "radicals": [ { "n": "1", "char": "一", "glyph": "⼀" }, /* … */ ],
  "chars": { "打": { "n": "64", "r": "手" }, "说": { "n": "149'", "r": "讠" } }
}
```

`chars` is keyed by character and covers **every Han character in
`scripts/hsk30.csv`** — 4,122 of 4,122 resolve a radical. The inventory comes
from the pinned CSV rather than from `data/hsk_bands.json` on purpose:
`data/radicals.json` is an *input* to the canon build, so reading the canon's own
output would make the two circular. The canon is read only when it already
exists, and only to print the coverage line.

`n` is the radical number with its apostrophes intact, so a pack can group on it.
`r` is the radical as an ordinary unified ideograph (手, 讠) rather than the
presentation form from the KangXi Radicals block (⼿, ⻈); the ideograph is the
one users can type and search for, and it is what the canon's `radical` field
wants. The presentation form is kept as `glyph` in the `radicals` table for
anyone rendering a radical index.

---

## Applying it to the canon

`src/build/canon.ts` is not edited by this build. Three lines, for its owner:

**1. `src/build/types.ts`** — declare the field on `WordRecord`, or the object
literal in `records.push({ … })` will not typecheck:

```ts
  /** Kangxi radical of the first character, as a unified ideograph. Null when unknown. */
  radical: string | null;
```

**2. `src/build/canon.ts`** — load the map, next to the other module-level paths
(after `const ENRICHMENT_JSON = …`):

```ts
const RADICALS = JSON.parse(readFileSync(`${DATA_DIR}radicals.json`, "utf8")).chars as Record<string, { n: string; r: string }>;
```

**3. `src/build/canon.ts`** — one line inside `records.push({ … })`, anywhere
after `traditional`:

```ts
      radical: RADICALS[[...simplified][0] ?? ""]?.r ?? null,
```

Then `build:radicals` has to run before `build:canon`, which means
`"build": "npm run build:radicals && npm run build:canon && npm run build:packs"`.

Nothing downstream needs changing: `src/build/packs.ts` already reads
`row["radical"]` and already adds a `radical` capability to any pack whose words
carry one, so the field lights up the pack layer the moment the canon emits it.

### Coverage

11,090 of 11,092 canon headwords (**99.98%**) resolve a radical from the first
character of their simplified column.

The two that do not are `…极了` and `…分之…`, whose first character is U+2026
HORIZONTAL ELLIPSIS — the HSK list's slot-pattern notation, not a character of
the word. They are notation, not missing data: strip the leading `…` and both
resolve (极 → 75 木, 分 → 18 刀). Whether to strip notation before the lookup is
canon.ts's call, so the one-liner above does not, and reports 99.98% honestly.

### Yield of a high-yield-radicals pack

201 distinct radicals across the canon's headwords. `CJKRadicals.txt` defines
246 in total — the 214 Kangxi radicals plus 32 simplified variants, which
`kRSUnicode` treats as radicals in their own right — and 230 of those are used by
some character somewhere in the HSK list, against 201 reached by a headword's
first character.

| Radical | | Headwords | Cumulative |
|---|---|---:|---:|
| 64 | 手 | 649 | 5.9% |
| 9 | 人 | 543 | 10.7% |
| 85 | 水 | 473 | 15.0% |
| 30 | 口 | 457 | 19.1% |
| 1 | 一 | 396 | 22.7% |
| 61 | 心 | 332 | 25.7% |
| 162 | 辵 | 319 | 28.6% |
| 75 | 木 | 289 | 31.2% |
| 149' | 讠 | 245 | 33.4% |
| 40 | 宀 | 204 | 35.2% |

Cut points for a pack:

| Threshold | Radicals | Headwords | Share of covered canon |
|---|---:|---:|---:|
| ≥ 200 headwords | 11 | 4,110 | 37.1% |
| ≥ 100 headwords | 27 | 6,400 | 57.7% |
| ≥ 50 headwords | 60 | 8,593 | 77.5% |
| ≥ 20 headwords | 110 | 10,286 | 92.8% |
| ≥ 10 headwords | 152 | 10,869 | 98.0% |

The distribution is long-tailed at both ends: 11 radicals carry 37% of the
canon, while 8 radicals carry exactly one headword each and 27 carry four or
fewer. A `high-yield-radicals` pack at the ≥100 cut is the natural shape — 27
radicals, 6,400 headwords, a bit under 58% of the corpus from a set a learner
can hold in their head.
