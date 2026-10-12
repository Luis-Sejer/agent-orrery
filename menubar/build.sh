#!/bin/sh
# Builds menubar/build/Agent Orrery.app (unsigned apart from an ad-hoc signature).
set -eu
cd "$(dirname "$0")"

swift build -c release
APP="build/Agent Orrery.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/AgentOrreryMenu "$APP/Contents/MacOS/AgentOrreryMenu"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dk.luissejer.agent-orrery.menubar</string>
  <key>CFBundleName</key><string>Agent Orrery</string>
  <key>CFBundleExecutable</key><string>AgentOrreryMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign -s - --force "$APP" 2>/dev/null && echo "signed ad hoc" || echo "codesign skipped"
echo "Built $PWD/$APP"
