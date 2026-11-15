// App root. Until the login/signup flow (D0-M4) and navigation land, the only screen is the
// build diagnostics screen (D0-M2). Keep the two providers at the root: gesture-handler 3 needs
// GestureHandlerRootView above any gesture (HoldToConfirm, D1-M5), and screens read safe-area
// insets.
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import DiagnosticsScreen from './src/diagnostics/DiagnosticsScreen';

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <DiagnosticsScreen />
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
