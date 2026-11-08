import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'app.dart';
import 'state/app_controller.dart';
import 'state/config.dart';
import 'ui/tokens.dart';
import 'wallet/key_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Palette.background,
    statusBarIconBrightness: Brightness.light,
    statusBarBrightness: Brightness.dark,
    systemNavigationBarColor: Palette.background,
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  final controller = AppController(
    config: AppConfig.fromEnvironment,
    keyStore: SecureKeyStore(),
    authenticator: LocalAuthenticator(),
  );
  runApp(VerdictApp(controller: controller));
  await controller.bootstrap();
}
