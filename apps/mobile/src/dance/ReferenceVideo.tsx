// The reference clip (when a routine has one, see media.ts), mirrored: players copy it like a
// mirror (DANCE-OFF §4.2). It plays with sound (the music is muxed in, one clock) from 0 at t0 —
// the same tick as startRound — and holds its first frame before that. Loaded lazily by Stage, so
// expo-video never loads for the skeleton-only routines.
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';

export default function ReferenceVideo({
  source,
  startAt,
}: {
  /** Metro asset id. */
  source: number;
  /** t0 (any non-null value starts playback), null before GO. */
  startAt: number | null;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0;
  });
  useEffect(() => {
    if (startAt === null) {
      player.pause();
      player.currentTime = 0;
      return;
    }
    player.currentTime = 0;
    player.play();
    return () => player.pause();
  }, [player, startAt]);
  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, styles.mirrored]}
      contentFit="contain"
      nativeControls={false}
      allowsPictureInPicture={false}
    />
  );
}

const styles = StyleSheet.create({ mirrored: { transform: [{ scaleX: -1 }] } });
