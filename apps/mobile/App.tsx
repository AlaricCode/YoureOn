// App root: the real, server-driven app (src/app/DemoApp). The build diagnostics (D0-M2), which
// also open the stand-in-data design preview (src/preview/PreviewApp), sit behind a hidden
// operator gesture: long-press the title on sign-up or the balance on home. Keep the two
// providers at the root: gesture-handler 3 needs GestureHandlerRootView above any gesture
// (HoldToConfirm), and screens read safe-area insets. A screen that throws shows "Try again"
// (src/app/AppErrorBoundary) instead of taking the app down.
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppErrorBoundary } from './src/app/AppErrorBoundary';
import DemoApp from './src/app/DemoApp';
import DiagnosticsScreen from './src/diagnostics/DiagnosticsScreen';

export default function App() {
  const [operator, setOperator] = useState(false);
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {operator ? (
          <DiagnosticsScreen onClose={() => setOperator(false)} />
        ) : (
          <AppErrorBoundary>
            {(attempt) => <DemoApp key={attempt} onOperator={() => setOperator(true)} />}
          </AppErrorBoundary>
        )}
        {/* Light text on the dark app; the diagnostics screen is white. */}
        <StatusBar style={operator ? 'dark' : 'light'} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
