/**
 * Legacy alfrd.net account screen — removed.
 * Linking is accountless (Desktop Client ID + claim secret).
 */
import { Redirect } from "expo-router";

export default function LegacyCloudLogin() {
  return <Redirect href="/(onboarding)/claim" />;
}
