#!/bin/sh
# Renders every brand asset in docs/assets from the sources in this folder:
# logo files, app icon, social images, the animated hero and the launch video.
# Needs Node 24, Google Chrome, ffmpeg and img2webp (`brew install webp`), and a built app:
# run `pnpm build` in the repository first. The recording uses the demo's made-up data only.
set -e
cd "$(dirname "$0")"
ASSETS=../assets
FPS=30
# The hero loop: from the overview, focus a session, search, and back (seconds of the recording).
HERO_START=0
HERO_END=13.3
# The video's middle: the same story, then the switch to dark where a session starts waiting on you.
VIDEO_START=1.0
VIDEO_END=20.6
# The video's cards: the title fades into the recording, which fades into the closing card.
TITLE_SECONDS=2.6
END_SECONDS=3.6
FADE=0.5
INTO_RECORDING=$(node -p "+($TITLE_SECONDS - $FADE).toFixed(3)")
INTO_END=$(node -p "+($INTO_RECORDING + $VIDEO_END - $VIDEO_START - $FADE).toFixed(3)")
VIDEO_SECONDS=$(node -p "+($INTO_END + $END_SECONDS).toFixed(3)")
# The still hero and the video poster: a session in focus, with its drawer open.
STILL_AT=4.6

[ -f ../../web/dist/index.html ] || { echo "Run pnpm build in the repository first"; exit 1; }
mkdir -p build

node brand.mjs
node stills.mjs
node record.mjs
node record.mjs --dark
TITLE_SECONDS=$TITLE_SECONDS END_SECONDS=$END_SECONDS node cards.mjs

# Screencast frames arrive when the page changes, so play each one for as long as it was on screen.
encode() {
    node -e '
const dir = process.argv[1]
const frames = require(`./${dir}/frames.json`)
const lines = ["ffconcat version 1.0"]
frames.forEach((frame, index) => {
  lines.push(`file ${frame.name}`, `duration ${((frames[index + 1]?.time ?? frame.time + 0.05) - frame.time).toFixed(4)}`)
})
lines.push(`file ${frames.at(-1).name}`)
require("fs").writeFileSync(`${dir}/list.ffconcat`, lines.join("\n"))
' "$1"
    ffmpeg -v error -y -f concat -safe 0 -i "$1/list.ffconcat" -vf "fps=$FPS,scale=1440:900:flags=lanczos,format=yuv420p" \
        -c:v libx264 -crf 12 -preset medium "$2"
}
encode build/rec build/recording.mp4
encode build/rec-dark build/recording-dark.mp4

ffmpeg -v error -y -ss $STILL_AT -i build/recording.mp4 -frames:v 1 "$ASSETS/hero.png"
ffmpeg -v error -y -ss $STILL_AT -i build/recording.mp4 -frames:v 1 -q:v 3 "$ASSETS/poster.jpg"

# Animated WebP autoplays in a README at a fraction of a GIF's size. The site shows the dark
# take when the visitor's system is dark.
webp() {
    rm -rf build/webp && mkdir -p build/webp
    ffmpeg -v error -ss $HERO_START -to $HERO_END -i "$1" -vf "fps=15" build/webp/%04d.png
    img2webp -loop 0 -lossy -q 70 -m 6 -d 67 build/webp/*.png -o "$2" >/dev/null
}
webp build/recording.mp4 "$ASSETS/hero.webp"
webp build/recording-dark.mp4 "$ASSETS/hero-dark.webp"

# The sound: a synthesised pad and effects on the logged moments. Nothing sampled.
node audio.mjs $VIDEO_SECONDS $VIDEO_START $VIDEO_END $TITLE_SECONDS $FADE $INTO_END

# The launch video: title card, the recording, then the closing card with the links.
ffmpeg -v error -y \
    -framerate $FPS -i build/cards/title/%04d.png \
    -ss $VIDEO_START -to $VIDEO_END -i build/recording.mp4 \
    -framerate $FPS -i build/cards/end/%04d.png \
    -i build/audio/mix.wav \
    -filter_complex "\
[0]format=yuv420p,setsar=1,fps=$FPS[title];\
[1]setpts=PTS-STARTPTS,format=yuv420p,setsar=1,fps=$FPS[rec];\
[2]format=yuv420p,setsar=1,fps=$FPS[end];\
[title][rec]xfade=transition=fade:duration=$FADE:offset=$INTO_RECORDING[a];\
[a][end]xfade=transition=fade:duration=$FADE:offset=$INTO_END,format=yuv420p[v]" \
    -map "[v]" -map 3:a -c:v libx264 -crf 24 -preset slow -tune animation -c:a aac -b:a 128k -shortest -movflags +faststart "$ASSETS/agent-orrery-launch.mp4"

echo "Rendered docs/assets: brand/, icon.png, social/, hero.webp, hero-dark.webp, hero.png, poster.jpg, agent-orrery-launch.mp4"
