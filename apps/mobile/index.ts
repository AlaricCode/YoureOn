// First, and before anything that builds styles: the interface scale for this device (an iPad
// draws everything larger). See src/ui/formFactor.
import './src/ui/formFactorBoot';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
