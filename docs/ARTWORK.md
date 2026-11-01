# Artwork in the preview

The initial artwork batch contains **two openly licensed gameplay illustrations**, served from this application's `public/game-images/` directory. The rest of the catalogue uses a title-based graphic until an appropriate image is available. A title graphic is a placeholder, not an official cover or screenshot.

The [machine-readable manifest](../public/artwork-manifest.json) binds each image to a canonical catalogue game ID and records dimensions, bilingual alternative text, creator credit, source, permission basis and licence. The runtime should show the credit plus source/licence links next to a profile image, or provide an equally accessible attribution link. It must retain the Wesnoth version/date notice.

## Included files

| Game / ID | File | Permission basis | Scope |
| --- | --- | --- | --- |
| Tactical Breach Wizards / `steam_1043810` | `tactical-breach-wizards.jpg` (960×600, 123283 bytes) | CC BY-SA 4.0, copyright-holder permission confirmed by Wikimedia VRT | Wikimedia's resized rendition; no Tactical Atlas pixel edits |
| The Battle for Wesnoth / `steam_599390` | `wesnoth-1-12.jpg` (1280×768, 551908 bytes) | GPL-2.0-or-later; file-specific licence and official project artwork policy | Unchanged historical version 1.12 screenshot from 2015; not current-build evidence |

[Public attribution and source details](../public/game-images/ATTRIBUTION.md) and the [GPL-2.0 text](../public/game-images/GPL-2.0.txt) accompany the assets. These two images are **not relicensed under MIT**. Displaying them does not imply creator/publisher endorsement. The JPEG files are directly downloadable in the forms described above.

Primary rights/source records checked on 1 November 2026:

- [Suspicious Developments screenshot and VRT-confirmed CC release](https://commons.wikimedia.org/wiki/File:Tactical-breach-wizards-screenshot.jpg).
- [Wesnoth screenshot and file-specific GPL notice](https://commons.wikimedia.org/wiki/File:Battle_for_wesnoth_version_1.12.0_screenshot.jpg).
- [Official Wesnoth project copyright policy](https://wiki.wesnoth.org/Wesnoth:Copyrights), which distinguishes GPL-licensed artwork and later CC BY-SA contributions. The selected 2015 screenshot carries an explicit GPL 2-or-later file licence.

## Catalogue entries using title graphics

No copied artwork has been bundled for these existing entries: BATTLETECH, XCOM 2, Into the Breach, Jagged Alliance 3, Battle Brothers, Wartales, Fell Seal, TRIANGLE STRATEGY, Solasta, Baldur's Gate 3 and Divinity: Original Sin 2.

For the planned additions, title graphics also cover Field of Glory II, Second Front, Combat Mission Shock Force 2, Xenonauts 2, Phoenix Point, Invisible Inc., Tactics Ogre Reborn, Troubleshooter, Vestaria Saga II, Urtuk and Chaos Gate—Daemonhunters. These are unfilled artwork slots; this bounded pass did not establish a suitable reusable asset for every game.

Public availability of a Steam capsule or press-kit page is not treated as blanket permission to copy or relicense it. In this pass the [older Battle Brothers press-kit page](https://www.battlebrothersgame.com/Press/presskit/index.php) offered no screenshot/logo downloads and contained obsolete template content. [Larian's policy](https://larian.com/fan-content-policy) separates BG3 terms and reserves logo/trademark rights; it was not treated as an unrestricted game-art licence for this application. The full original artwork can be added as an ordinary data update when its intended display, hosting and redistribution terms are clear.

## Adding an image

1. Confirm the depicted game/edition and an appropriate creator/publisher or openly licensed source.
2. Record a specific permission basis that covers display and any local copy. Keep original legal notices and any required source/licence links.
3. Put the permitted asset under `public/game-images/`, with known width/height and concise English/Chinese alt text. Prefer a modest download size; load images lazily with fixed aspect ratio and an error fallback.
4. Add its canonical ID to the manifest and update public attribution. Keep external artwork separate from the code licence; preserve any share-alike terms on the image.
5. Check broken-image behavior and game/profile presentation. An illustration is not a new source of gameplay evidence or a game-quality judgment.

No image generation, Steam API key, external image service, new subscription or paid AI request was used for this artwork batch.
