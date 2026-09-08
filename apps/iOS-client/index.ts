import "react-native-get-random-values";
import "react-native-reanimated";
// Must run before expo-router pulls in Talk / livekit-client.
import "./src/lib/voice/register-livekit";
import { LogBox } from "react-native";
import "./global.css";
import "expo-router/entry";

LogBox.ignoreLogs(["Expo AV has been deprecated", "Disconnected from Metro"]);
