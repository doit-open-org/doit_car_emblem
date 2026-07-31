import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  sendCmd(payload: string): Promise<string>;
  sendDataByType(payload: string): Promise<string>;
  sendThirdBleData(payload: string): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>("NativeLocalStorage");
