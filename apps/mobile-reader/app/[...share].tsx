import { Redirect } from "expo-router";

// Android share/open intents can wake the app with provider-backed URLs such as
// spine://com.whatsapp.provider.media/item/..., which are not app routes. The
// root layout consumes the native share intent and imports the file; this
// catch-all prevents Expo Router from showing its unmatched-route screen during
// that handoff.
export default function ExternalShareBridge() {
  return <Redirect href="/library" />;
}
