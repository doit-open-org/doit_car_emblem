/**
 * Bundle entry. The native host currently uses the panel URL as componentName.
 * Keep the stable name as well so the bundle also works in local debugging.
 */
import { AppRegistry } from "react-native";
import App from "./App";

const componentNames = ["2026061719070006", "BaomaPanel"];

componentNames.forEach((componentName) => {
  AppRegistry.registerComponent(componentName, () => App);
});
