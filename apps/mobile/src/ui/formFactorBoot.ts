// Sets the interface scale for this device (./formFactor). This module must be evaluated before
// any module that builds styles from ./tokens, so it is the FIRST import of the app entry
// (index.ts): imports are evaluated in source order, and this one has no other job.
//
// The scale is measured against the app's WINDOW as it starts, not the screen: an iPad app
// launched into a narrow window (Split View, Slide Over, a small Stage Manager window) is a
// phone-sized app and is drawn like one. Before the window is known the screen stands in.
import { Dimensions, Platform } from 'react-native';

import { scaleFor, setUiScale } from './formFactor';

const shortSide = (d: { width: number; height: number }) => Math.min(d.width, d.height);

const windowSide = shortSide(Dimensions.get('window'));
const side = windowSide > 0 ? windowSide : shortSide(Dimensions.get('screen'));
setUiScale(scaleFor(side, Platform.OS === 'ios' && Platform.isPad));
