---
name: project-direction
description: Current FieldCast project direction — mobile app abandoned, web-client is the main client
metadata:
  type: project
---

Mobile React Native / Expo app has been abandoned (too many problems with native modules).

**Current plan:** `web-client/` (Vite + React) is the main client for reporters and anchors. It will be wrapped in an Android WebView via the existing `android-wrapper/` project. The `android-wrapper/` already has the WebView setup with camera/mic permission grants.

**Why:** Native modules (LiveKit RN, expo-camera, react-native-webrtc) caused too much friction. The web approach uses standard browser APIs (getUserMedia, MediaRecorder, WebSocket) which work fine in Android WebView.

**How to apply:** Do not create or suggest mobile (React Native / Expo) code. All reporter, anchor, and admin UI goes into `web-client/`. The `mobile(aborted)/` folder can be ignored.
