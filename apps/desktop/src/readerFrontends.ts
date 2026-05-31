export type ReaderFrontendId = "foliate-js";

export type ReaderFrontendManifest = {
  id: ReaderFrontendId;
  name: string;
  packaged: true;
  platform: "desktop";
  formats: string[];
  transport: "tauri-resource-bridge";
};

export const packagedReaderFrontend: ReaderFrontendManifest = {
  id: "foliate-js",
  name: "Foliate JS",
  packaged: true,
  platform: "desktop",
  formats: ["EPUB"],
  transport: "tauri-resource-bridge",
};
