import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/ws/ws_client.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/fake_channel.dart';
import '../support/fixtures.dart';

void main() {
  test('URL, subscribe on connect, messages, ping, resubscribe after reconnect', () async {
    final channels = <FakeChannel>[];
    final ws = WsClient(
      baseUrl: 'https://api.test',
      token: 'tok',
      pingInterval: const Duration(milliseconds: 20),
      maxBackoff: const Duration(milliseconds: 600),
      connect: (u) {
        final c = FakeChannel(u);
        channels.add(c);
        return c;
      },
    );
    expect(ws.uri.toString(), 'wss://api.test/v1/ws?token=tok');

    ws.subscribe(['user']);
    final got = <WsMessage>[];
    final sub = ws.messages.listen(got.add);
    ws.open();
    await Future<void>.delayed(const Duration(milliseconds: 5));
    expect(channels.single.sent.first, {
      'type': 'subscribe',
      'topics': ['user'],
    });

    ws.subscribe([Topics.bet('b1'), 'user']);
    expect(channels.single.sent.last, {
      'type': 'subscribe',
      'topics': ['bet:b1'],
    });

    channels.single.push({'type': 'bet', 'bet': betJson()});
    channels.single.push({'type': 'notify', 'title': 'Ready', 'bet_id': 'b1'});
    channels.single.fromServer.add('not json');
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(got.whereType<WsBet>().length, 1);
    expect(got.whereType<WsNotify>().single.title, 'Ready');
    expect(channels.single.sent.any((m) => m['type'] == 'ping'), isTrue);

    ws.sendRecording('b1', 'W');
    expect(channels.single.sent.last, {'type': 'recording', 'bet_id': 'b1', 'witness_key': 'W'});

    // Server drops the socket: the client reconnects and re-subscribes all.
    await channels.single.drop();
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(channels.length, 2);
    final resub = channels[1].sent.first;
    expect(resub['type'], 'subscribe');
    expect((resub['topics'] as List).toSet(), {'user', 'bet:b1'});

    ws.unsubscribe(['bet:b1']);
    expect(channels[1].sent.last, {
      'type': 'unsubscribe',
      'topics': ['bet:b1'],
    });

    await sub.cancel();
    await ws.close();
  });
}
