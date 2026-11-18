// The last line of defence for the real app: a screen that throws while rendering (an unexpected
// server payload, a bug) would otherwise take the whole app down in a Release build. This shows
// "Something went wrong" with "Try again", which remounts the app: the session restores from
// the Keychain and an open bet comes back (app/resume), so a stage demo can carry on.
import { Component, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { COPY, t } from '../screens/copy';
import { PrimaryButton } from '../ui/kit';
import { Page, Screen, StatusHero } from '../ui/parts';

interface Props {
  children: (attempt: number) => ReactNode;
}

interface State {
  failed: boolean;
  attempt: number;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('[yo] app crashed', error instanceof Error ? error.message : String(error));
  }

  override render() {
    if (!this.state.failed) return this.props.children(this.state.attempt);
    return (
      <Screen>
        <Page>
          <View style={styles.center}>
            <StatusHero mark="cross" title={t(COPY.app.crashed)} />
          </View>
          <PrimaryButton
            testID="app-retry"
            label={t(COPY.app.failed)}
            onPress={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
          />
        </Page>
      </Screen>
    );
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
