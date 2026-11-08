import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

/// Persistent secret storage (Keychain / Android Keystore-backed).
abstract class KeyStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureKeyStore implements KeyStore {
  SecureKeyStore([FlutterSecureStorage? storage])
      : _s = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  final FlutterSecureStorage _s;

  @override
  Future<String?> read(String key) => _s.read(key: key);

  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

/// In-memory store for tests and previews.
class MemoryKeyStore implements KeyStore {
  final Map<String, String> data = {};

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async => data[key] = value;

  @override
  Future<void> delete(String key) async => data.remove(key);
}

/// The device passkey / biometric prompt that unlocks the wallet ([D-10],
/// [D-41]). Returns true when the user passed the prompt.
abstract class Authenticator {
  Future<bool> unlock();
}

class LocalAuthenticator implements Authenticator {
  LocalAuthenticator([LocalAuthentication? auth]) : _auth = auth ?? LocalAuthentication();
  final LocalAuthentication _auth;

  @override
  Future<bool> unlock() async {
    final supported = await _auth.isDeviceSupported();
    // A device with no lock screen at all cannot gate the key; the key is
    // still protected by secure storage. Simulators fall in this case.
    if (!supported) return true;
    try {
      return await _auth.authenticate(
        localizedReason: 'Confirm',
        options: const AuthenticationOptions(biometricOnly: false, stickyAuth: true),
      );
    } on Exception {
      return false;
    }
  }
}

/// Always-yes authenticator for tests.
class AllowAuthenticator implements Authenticator {
  int prompts = 0;
  bool answer = true;

  @override
  Future<bool> unlock() async {
    prompts++;
    return answer;
  }
}
