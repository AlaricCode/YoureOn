// Demo account (DEMO_MODE only; API-CONTRACT §2.1 demo-claim, §2.17): scan the one-time QR the
// stage shows to take over one of the team's seeded accounts. The accounts are custodial, and
// the README says so. Opened from a youreon:// demo-claim link (app/deepLink),
// the code is already there and the claim waits for an explicit "Use this account": it replaces
// this phone's wallet, so a link alone never claims.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { hasCameraLens } from '../device/camera';
import {
  AlertLine,
  BackdropProvider,
  PrimaryButton,
  QuietButton,
  Stage,
  StageBubble,
} from '../ui/kit';
import { Page, Screen, StatusHero, TopBar } from '../ui/parts';
import { dp, palette, radius, space } from '../ui/tokens';
import { COPY, t } from './copy';

/** Four thin white corners framing where the stage code goes. Decoration only. */
function Viewfinder() {
  return (
    <View style={styles.finderWrap} pointerEvents="none">
      <View style={styles.finder}>
        <View style={[styles.corner, styles.tl]} />
        <View style={[styles.corner, styles.tr]} />
        <View style={[styles.corner, styles.bl]} />
        <View style={[styles.corner, styles.br]} />
      </View>
    </View>
  );
}

export function DemoClaimScreen({
  onBack,
  claim,
  onDone,
  tag,
  linkCode = null,
}: {
  onBack: () => void;
  /** POST /v1/auth/demo-claim with the scanned token; resolves the account's name, or null. */
  claim: (qr: string) => Promise<string | null>;
  onDone: () => void;
  tag?: string | undefined;
  /** The claim token from a youreon:// link; no camera needed. */
  linkCode?: string | null;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  /** The camera failed to start, or it started with no lens (the simulator). */
  const [noCamera, setNoCamera] = useState(false);
  const cam = useRef<CameraView | null>(null);

  useEffect(() => {
    if (linkCode) return;
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission, linkCode]);

  const scanned = async (data: string) => {
    if (checking || name) return;
    setChecking(true);
    setAlert(null);
    const who = await claim(data);
    setChecking(false);
    if (who) setName(who);
    else setAlert(t(COPY.demo.badCode));
  };

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.demo.title)} tag={tag} />
      <Page>
        {name ? (
          <Stage style={[styles.stage, styles.center]}>
            <StatusHero mark="check" title={t(COPY.demo.done)} detail={name} />
          </Stage>
        ) : linkCode ? (
          <Stage style={[styles.stage, styles.center]}>
            <StatusHero mark="ring" title={t(COPY.demo.title)} />
          </Stage>
        ) : permission?.granted ? (
          <Stage style={styles.stage}>
            <CameraView
              ref={cam}
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={checking ? undefined : (r) => void scanned(r.data)}
              onCameraReady={() => void hasCameraLens(cam.current).then((ok) => setNoCamera(!ok))}
              onMountError={() => setNoCamera(true)}
            />
            {noCamera ? null : <Viewfinder />}
            {noCamera ? (
              // No lens (the simulator): the note sits in the middle of the stage, as on Scan.
              <View style={styles.finderWrap} pointerEvents="none">
                <StageBubble prompt={t(COPY.judgeCam.noCamera)} centered />
              </View>
            ) : (
              <StageBubble prompt={t(COPY.demo.scan)} checking={checking} />
            )}
          </Stage>
        ) : (
          <Stage style={[styles.stage, styles.center]}>
            {/* On the raised stage the quiet button keeps its #1C1C1F fill. */}
            <BackdropProvider value="raised">
              <QuietButton
                label={t(COPY.scan.allowCamera)}
                onPress={() => void requestPermission()}
              />
            </BackdropProvider>
          </Stage>
        )}
        <AlertLine message={alert} />
        {linkCode && !name ? (
          <PrimaryButton
            testID="demo-use-link"
            label={t(COPY.demo.useLink)}
            busy={checking}
            onPress={() => void scanned(linkCode)}
          />
        ) : (
          <PrimaryButton label={t(COPY.demo.continue)} disabled={!name} onPress={onDone} />
        )}
      </Page>
    </Screen>
  );
}

const FINDER = dp(220);
const CORNER = space.x5;
const STROKE = 2;

const styles = StyleSheet.create({
  stage: { marginTop: space.x1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x3 },
  finderWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finder: { width: FINDER, height: FINDER },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: palette.text },
  tl: {
    top: 0,
    left: 0,
    borderTopWidth: STROKE,
    borderLeftWidth: STROKE,
    borderTopLeftRadius: radius.md,
  },
  tr: {
    top: 0,
    right: 0,
    borderTopWidth: STROKE,
    borderRightWidth: STROKE,
    borderTopRightRadius: radius.md,
  },
  bl: {
    bottom: 0,
    left: 0,
    borderBottomWidth: STROKE,
    borderLeftWidth: STROKE,
    borderBottomLeftRadius: radius.md,
  },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: STROKE,
    borderRightWidth: STROKE,
    borderBottomRightRadius: radius.md,
  },
});
