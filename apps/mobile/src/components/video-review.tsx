import Feather from '@expo/vector-icons/Feather';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function VideoReview({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri, useCaching: false }, player => {
    player.loop = false;
    player.allowsExternalPlayback = false;
    player.play();
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  return <View style={StyleSheet.absoluteFill}>
    <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain"
      surfaceType="textureView" nativeControls={false} allowsPictureInPicture={false}
      fullscreenOptions={{ enable: false }} accessibilityLabel="Your captured video" />
    <Pressable accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
      style={styles.playback} onPress={() => {
        if (isPlaying) player.pause();
        else {
          if (player.currentTime >= player.duration - 0.1) player.currentTime = 0;
          player.play();
        }
      }}>
      <Feather name={isPlaying ? 'pause' : 'play'} size={25} color="#fff" />
    </Pressable>
    {status === 'error' && <Text style={styles.error}>This video couldn’t play. Try recording again.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  playback: { position: 'absolute', alignSelf: 'center', top: '46%', width: 58, height: 58, borderRadius: 29, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center' },
  error: { position: 'absolute', top: '36%', left: 24, right: 24, color: '#fff', textAlign: 'center' },
});
