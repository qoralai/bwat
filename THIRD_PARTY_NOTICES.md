# Third-party notices

bwat is licensed under the Elastic License 2.0 (`LICENSE`). This repository also carries the
following third-party material, each under its own licence.

## marked

`setup/onboard/vendor/marked.esm.js` and `marked.esm.d.ts`: [marked](https://github.com/markedjs/marked)
18.0.14, copied unchanged for the setup page. MIT licence, with the Markdown licence it includes,
in full in `setup/onboard/vendor/marked.LICENSE`.

- Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
- Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
- Copyright © 2004, John Gruber (http://daringfireball.net/)

## Zoom Meeting SDK headless Linux sample

`bot/sdk/bwat-sample.patch` is a patch to
[zoom/meetingsdk-headless-linux-sample](https://github.com/zoom/meetingsdk-headless-linux-sample)
at the commit `bot/sdk/zoom-sdk.lock` pins, and carries lines of that sample's code.

```text
MIT License

Copyright (c) 2022 Zoom Video Communications, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The Zoom Meeting SDK

The Zoom Meeting SDK is **not** in this repository and is never distributed with bwat. Each
company downloads it from its own Zoom app under Zoom's terms, and builds its own bot image from
it (`bot/sdk/README.md`, `docs/hosting.md`).

## bwat's own images and test fixtures

The images (`bot/presence/default.png`, `web/admin/public/presence-default.png`,
`web/pages/board/ui/bwat-icon.svg`) and the test fixtures, such as the synthetic tone in
`bot/tests/fixtures/speech.wav`, are made in-house and are under bwat's licence.

## Dependencies

The npm and Python packages bwat uses are not vendored here. They are installed from their
registries when an image is built (`backend/package-lock.json`, `web/package-lock.json`,
`bot/requirements.txt`, `cards/requirements.txt`), each under its own licence.
