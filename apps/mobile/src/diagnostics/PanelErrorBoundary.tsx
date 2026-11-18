// Catches a camera panel that fails to load (e.g. its native module is missing from the build)
// or throws while rendering, and reports it as a failed check instead of a red screen.
import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { palette, radius, space, type } from '../ui/tokens';
import { describeError } from './runner';

interface Props {
  name: string;
  onError: (message: string) => void;
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: describeError(error) };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(describeError(error));
  }

  override render() {
    if (this.state.message !== null) {
      return (
        <View style={styles.box}>
          <Text style={styles.title}>{this.props.name} failed to load</Text>
          <Text style={styles.message}>{this.state.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: { padding: space.x2, borderRadius: radius.lg, backgroundColor: palette.surface },
  title: { ...type.labelStrong, color: palette.danger },
  message: { ...type.small, marginTop: 4 },
});
