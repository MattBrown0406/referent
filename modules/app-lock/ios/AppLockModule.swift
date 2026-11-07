import ExpoModulesCore
import LocalAuthentication
import UIKit

// The app's cover, in a window of its own above every sheet, alert and menu
// (a React view cannot cover a sheet that is already open):
// - Privacy: up whenever the app stops being active, so the app switcher's
//   snapshot (and Control Center, an incoming call) never shows a case.
// - Lock: when "Lock with Face ID" is on, up from launch and whenever the app
//   comes back after the chosen time away, until Face ID or the passcode.
// The setting lives in UserDefaults on this phone only, so the lock is up
// before any screen draws.
public class AppLockModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppLock")

    OnCreate {
      DispatchQueue.main.async { AppLockController.shared.start() }
    }

    Function("getStatus") { () -> [String: Any] in
      return AppLockController.status()
    }

    // Turning the lock on asks for Face ID (or the passcode) first, so it is
    // never switched on for someone who cannot open it.
    AsyncFunction("enable") { (graceSeconds: Double, reason: String, promise: Promise) in
      AppLockController.shared.authenticate(reason: reason) { ok, error in
        if ok { AppLockController.save(enabled: true, graceSeconds: graceSeconds) }
        var result: [String: Any] = ["ok": ok]
        if let error { result["error"] = error }
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    Function("disable") {
      AppLockController.save(enabled: false, graceSeconds: nil)
    }

    Function("setGraceSeconds") { (seconds: Double) in
      AppLockController.save(enabled: nil, graceSeconds: seconds)
    }
  }
}

final class AppLockController: NSObject {
  static let shared = AppLockController()

  private static let enabledKey = "referralfit.appLock.enabled"
  private static let graceKey = "referralfit.appLock.graceSeconds"
  static let defaultGraceSeconds: Double = 60

  private var window: UIWindow?
  private var started = false
  private var locked = false
  private var authenticating = false
  // One automatic Face ID prompt per return to the app; after a cancel the
  // Unlock button stays until tapped.
  private var promptedThisVisit = false
  // A monotonic clock that keeps counting while the phone sleeps
  // (systemUptime stops, so an hour asleep read as seconds away). Not the
  // wall clock: changing the phone's time cannot skip the lock.
  private var leftAt: TimeInterval?
  // Windows behind the lock that VoiceOver must not read (a modal view only
  // hides its own window's views).
  private var hiddenFromVoiceOver: [Weak] = []

  private struct Weak { weak var window: UIWindow? }

  static func now() -> TimeInterval {
    TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000
  }

  static var enabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }

  static var graceSeconds: Double {
    let value = UserDefaults.standard.object(forKey: graceKey) as? Double
    return value.map { max(0, $0) } ?? defaultGraceSeconds
  }

  static func save(enabled: Bool?, graceSeconds: Double?) {
    if let enabled { UserDefaults.standard.set(enabled, forKey: enabledKey) }
    if let graceSeconds, graceSeconds.isFinite { UserDefaults.standard.set(max(0, graceSeconds), forKey: graceKey) }
  }

  static func status() -> [String: Any] {
    let context = LAContext()
    let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    let biometricsReady = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    return [
      "available": available,
      "biometry": biometricsReady ? biometryName(context.biometryType) : "none",
      "enabled": enabled,
      "graceSeconds": graceSeconds,
    ]
  }

  private static func biometryName(_ type: LABiometryType) -> String {
    switch type {
    case .faceID: return "faceID"
    case .touchID: return "touchID"
    default:
      if #available(iOS 17.0, *), type == .opticID { return "opticID" }
      return "none"
    }
  }

  func start() {
    guard !started else { return }
    started = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillShowNotification, object: nil)
    if Self.enabled {
      lock()
      if UIApplication.shared.applicationState == .active { promptIfNeeded() }
    }
  }

  @objc private func willResignActive() {
    // Before the snapshot: cover now, whatever the reason for leaving.
    show()
  }

  @objc private func didEnterBackground() {
    leftAt = Self.now()
    promptedThisVisit = false
    show()
  }

  @objc private func willEnterForeground() {
    if Self.enabled, !locked, let leftAt, Self.now() - leftAt >= Self.graceSeconds {
      lock()
    }
    leftAt = nil
  }

  // Locked: the cover is up and nothing behind it takes typing. iOS brings
  // the keyboard back for the field that had it, and the keyboard's window
  // sits above every app window, so the hidden field would show its
  // suggestions and take keys (a hardware keyboard too).
  private func lock() {
    locked = true
    endEditing()
    show()
  }

  private func endEditing() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  }

  // A field that takes focus while locked (a sheet opened by a notification
  // tap) gives it up again. Not during Face ID: the passcode is not ours.
  @objc private func keyboardWillShow() {
    if locked, !authenticating { endEditing() }
  }

  @objc private func didBecomeActive() {
    // Face ID's own sheet makes the app inactive and active again; its
    // answer decides, not this.
    if authenticating { return }
    if locked {
      show()
      promptIfNeeded()
    } else {
      hide()
    }
  }

  private func promptIfNeeded() {
    guard locked, !authenticating, !promptedThisVisit, UIApplication.shared.applicationState == .active else { return }
    promptedThisVisit = true
    unlock()
  }

  fileprivate func unlock() {
    authenticate(reason: "Unlock ReferralFit to see your cases.") { [weak self] ok, error in
      guard let self else { return }
      if ok || error == "passcodeNotSet" {
        // Without a passcode nothing can open the lock: turn it off rather
        // than shut the person out of their own app.
        if !ok { Self.save(enabled: false, graceSeconds: nil) }
        self.locked = false
        // An answer that lands after the person left keeps the cover up for
        // the app switcher; didBecomeActive takes it down on return.
        if UIApplication.shared.applicationState == .active { self.hide() }
      } else {
        self.show()
      }
    }
  }

  func authenticate(reason: String, completion: @escaping (Bool, String?) -> Void) {
    guard !authenticating else {
      completion(false, "busy")
      return
    }
    let context = LAContext()
    var canError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError) else {
      completion(false, canError?.code == LAError.passcodeNotSet.rawValue ? "passcodeNotSet" : "unavailable")
      return
    }
    authenticating = true
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
      DispatchQueue.main.async {
        self.authenticating = false
        // The sheet put the privacy cover up (willResignActive), and
        // didBecomeActive skipped it while this was in flight.
        if !self.locked, UIApplication.shared.applicationState == .active { self.hide() }
        completion(ok, ok ? nil : Self.errorName(error))
      }
    }
  }

  private static func errorName(_ error: Error?) -> String {
    guard let error = error as? LAError else { return "failed" }
    switch error.code {
    case .userCancel, .appCancel, .systemCancel, .userFallback: return "cancelled"
    case .passcodeNotSet: return "passcodeNotSet"
    default: return "failed"
    }
  }

  private func show() {
    if window == nil {
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      guard let scene = scenes.first(where: { $0.activationState == .foregroundActive })
        ?? scenes.first(where: { $0.activationState == .foregroundInactive })
        ?? scenes.first else { return }
      let cover = AppLockWindow(windowScene: scene)
      // React Native puts each Alert.alert in a window at .alert + 1 and
      // makes it key: the cover stays above them, so an alert raised while
      // locked waits behind it.
      cover.windowLevel = .alert + 2
      let controller = AppLockViewController()
      controller.onUnlock = { [weak self] in self?.unlock() }
      cover.rootViewController = controller
      window = cover
    }
    guard let window, let controller = window.rootViewController as? AppLockViewController else { return }
    controller.update(locked: locked, biometry: Self.status()["biometry"] as? String ?? "none")
    window.isHidden = false
    if locked {
      hideOthersFromVoiceOver(except: window)
      UIAccessibility.post(notification: .screenChanged, argument: controller.focusTarget)
    }
  }

  private func hide() {
    window?.isHidden = true
    for entry in hiddenFromVoiceOver { entry.window?.accessibilityElementsHidden = false }
    hiddenFromVoiceOver = []
  }

  private func hideOthersFromVoiceOver(except cover: UIWindow) {
    guard let scene = cover.windowScene else { return }
    for other in scene.windows where other !== cover && !other.accessibilityElementsHidden {
      other.accessibilityElementsHidden = true
      hiddenFromVoiceOver.append(Weak(window: other))
    }
  }
}

// Never the key window: React Native presents its sheets and alerts from the
// key window, and the hardware keyboard types into it.
final class AppLockWindow: UIWindow {
  override var canBecomeKey: Bool { false }
}

final class AppLockViewController: UIViewController {
  var onUnlock: (() -> Void)?

  private static let paper = UIColor(red: 0xF6 / 255, green: 0xF4 / 255, blue: 0xEE / 255, alpha: 1)
  private static let forest = UIColor(red: 0x1F / 255, green: 0x5A / 255, blue: 0x49 / 255, alpha: 1)
  private static let ink = UIColor(red: 0x16 / 255, green: 0x35 / 255, blue: 0x2E / 255, alpha: 1)
  private static let muted = UIColor(red: 0x38 / 255, green: 0x56 / 255, blue: 0x4F / 255, alpha: 1)

  private let icon = UIImageView()
  private let titleLabel = UILabel()
  private let messageLabel = UILabel()
  private let button = UIButton(type: .system)

  var focusTarget: Any? { button.isHidden ? titleLabel : button }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Self.paper
    view.accessibilityViewIsModal = true

    icon.image = UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .semibold))
    icon.tintColor = Self.forest
    icon.contentMode = .scaleAspectFit
    icon.isAccessibilityElement = false

    titleLabel.text = "ReferralFit"
    titleLabel.font = .systemFont(ofSize: 26, weight: .bold)
    titleLabel.textColor = Self.forest
    titleLabel.textAlignment = .center

    messageLabel.text = "Locked. Your cases stay hidden until you unlock."
    messageLabel.font = .systemFont(ofSize: 16)
    messageLabel.textColor = Self.muted
    messageLabel.numberOfLines = 0
    messageLabel.textAlignment = .center

    var config = UIButton.Configuration.filled()
    config.baseBackgroundColor = Self.forest
    config.baseForegroundColor = .white
    config.cornerStyle = .large
    config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 24, bottom: 14, trailing: 24)
    button.configuration = config
    button.addTarget(self, action: #selector(tapUnlock), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [icon, titleLabel, messageLabel, button])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 14
    stack.setCustomSpacing(28, after: messageLabel)
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      messageLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
    ])
  }

  func update(locked: Bool, biometry: String) {
    loadViewIfNeeded()
    icon.isHidden = !locked
    messageLabel.isHidden = !locked
    button.isHidden = !locked
    let name: String
    switch biometry {
    case "faceID": name = "Unlock with Face ID"
    case "touchID": name = "Unlock with Touch ID"
    case "opticID": name = "Unlock with Optic ID"
    default: name = "Unlock with passcode"
    }
    var title = AttributedString(name)
    title.font = .systemFont(ofSize: 17, weight: .semibold)
    button.configuration?.attributedTitle = title
  }

  @objc private func tapUnlock() {
    onUnlock?()
  }

  override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }
}
