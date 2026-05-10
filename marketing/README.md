# marketing/

Generated brand and store assets. **Nothing in here ships in the extension
or the CLI** — these are uploaded by hand to the Chrome Web Store, YouTube,
and the website.

The `cws/` and `video/` subdirectories are git-ignored (see `.gitignore`).
They're recreated on demand by:

```bash
npm run build:cws-assets    # promo tile, marquee, 5 gallery shots, title + outro cards
npm run build:demo-video    # browy-demo.mp4 (~24 s animated reel)
```

Both scripts read the mascot from `extension/icons/icon.svg` and the
side-panel screenshots from `../browy-docs/src/assets/screenshots/`. Outputs:

```
marketing/
  cws/
    promo-tile.png      440 x 280     CWS small promo tile
    marquee.png         1400 x 560    CWS marquee tile
    screenshot-1..5.png 1280 x 800    gallery
  video/
    title-card.png      1920 x 1080   demo video title frame
    outro-card.png      1920 x 1080   demo video outro frame
    browy-demo.mp4      1280 x 720    24 s animated reel
```

Source of truth is the generator scripts (`scripts/build-cws-assets.mjs` and
`scripts/build-demo-video.mjs`) plus the mascot SVG. To change branding,
edit those — don't try to edit the PNGs.
