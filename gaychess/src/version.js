export const APP_BUILD='2026-10-17-vendored-pieces-1';
export const MULTIPLAYER_PROTOCOL=1;
export const ENGINE_COMMIT='04ac5096d378758750e19ba184732ffdfc133bd2';
export const RULES_SHA256='2c9c77a8ce1cfd200ecef0c1fb496aa471f8e426b8b39eaaaefa4aa54132980b';
export const WASM_SHA256='7a6505d6a55da3b5dbfb9522e69470031c39c5e9a85aa759c0d809fef48ffa8f';
export const ENGINE_ASSET_ID='04ac509-7a6505d6';

export const COMPATIBILITY_ID=[
  `protocol:${MULTIPLAYER_PROTOCOL}`,
  `app:${APP_BUILD}`,
  `engine:${ENGINE_COMMIT}`,
  `rules:${RULES_SHA256}`,
  `wasm:${WASM_SHA256}`,
].join('|');
