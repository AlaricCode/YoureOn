// Demo account (DEMO_MODE only; API-CONTRACT §2.1 demo-claim, §2.17): scan the one-time QR the
// stage shows to take over one of the team's seeded accounts. The accounts are custodial, and
// the README says so (FINDINGS §3.4).
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { hasCameraLens } from '../device/camera';
import { AlertLine, PrimaryButton, QuietButton, Stage, StageBubble } from '../ui/kit';
import { Page, Screen, StatusHero, TopBar } from '../ui/parts';
import { COPY, t } from './copy';

export function DemoClaimScreen({
  onBack,
  claim,
  onDone,
  tag,
}: {
  onBack: () => void;
  /** POST /v1/auth/demo-claim with the scanned token; resolves the account's name, or null. */
  claim: (qr: string) => Promise<string | null>;
  onDone: () => void;
  tag?: string | undefined;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  /** The camera failed to start, or it started with no lens (the simulator). */
  const [noCamera, setNoCamera] = useState(false);
  const cam = useRef<CameraView | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

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
          <Stage style={styles.center}>
            <StatusHero mark="check" title={t(COPY.demo.done)} detail={name} />
          </Stage>
        ) : permission?.granted ? (
          <Stage>
            <CameraView
              ref={cam}
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={checking ? undefined : (r) => void scanned(r.data)}
              onCameraReady={() => void hasCameraLens(cam.current).then((ok) => setNoCamera(!ok))}
              onMountError={() => setNoCamera(true)}
            />
            <StageBubble
              prompt={t(noCamera ? COPY.judgeCam.noCamera : COPY.demo.scan)}
              checking={checking}
            />
          </Stage>
        ) : (
          <Stage style={styles.center}>
            <QuietButton
              label={t(COPY.scan.allowCamera)}
              onPress={() => void requestPermission()}
            />
          </Stage>
        )}
        <AlertLine message={alert} />
        <PrimaryButton label={t(COPY.demo.continue)} disabled={!name} onPress={onDone} />
      </Page>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
