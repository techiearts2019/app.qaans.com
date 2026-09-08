import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { LinearGradient } from "expo-linear-gradient";
import * as Speech from "expo-speech";
import { useFocusEffect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PrimaryButton } from "@/src/components/PrimaryButton";
import { Avatar } from "@/src/components/Avatar";
import { api, Employee, FaceMatchItem, FaceMatchResult } from "@/src/lib/api";
import { colors, radius, shadow } from "@/src/theme/colors";

type Phase = "idle" | "scanning" | "matched";

// keep the last-detected face boxes on-screen briefly after each match tick
// so the overlay doesn't flicker between polls.
const BOX_TTL_MS = 2200;

const MATCH_INTERVAL_MS = 1500;
const MATCH_MODAL_AUTOCLOSE_MS = 3000;
const PER_EMPLOYEE_COOLDOWN_MS = 60_000;

export default function FaceAttendance() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<"front" | "back">("front");
  const [phase, setPhase] = useState<Phase>("scanning");
  const [action, setAction] = useState<"Check-in" | "Check-out">("Check-in");
  const [isFocused, setIsFocused] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [matched, setMatched] = useState<FaceMatchResult["employee"] | null>(null);
  const [matchTime, setMatchTime] = useState<string>("");
  const [facesInFrame, setFacesInFrame] = useState(0);
  const [matchQueue, setMatchQueue] = useState<FaceMatchItem[]>([]);
  const [inFlight, setInFlight] = useState(false);
  const [boxes, setBoxes] = useState<FaceMatchItem[]>([]);
  const [cameraLayout, setCameraLayout] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollEmp, setEnrollEmp] = useState<Employee | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView | null>(null);
  const busyRef = useRef(false);
  // cooldown so the same person doesn't double-punch within 60s
  const cooldownRef = useRef<Map<string, number>>(new Map());

  // animations
  const scanLine = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;
  const cornerOpacity = useRef(new Animated.Value(0.7)).current;

  // Pause / resume scanning when the screen gains or loses focus.
  // NOTE: expo-router's useFocusEffect can be flaky on Android release
  // builds for the initial route, so we ALSO force isFocused=true on mount
  // (see the useEffect below). That guarantees polling starts on cold boot.
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      setPhase("scanning");
      // Reload employees list on focus (in case new ones were added)
      api
        .listEmployees()
        .then(setEmployees)
        .catch((e) => console.warn("faces load failed", e));
      return () => {
        setIsFocused(false);
        setPhase("idle");
        try {
          Speech.stop();
        } catch {
          // noop
        }
      };
    }, [])
  );

  // Belt-and-braces: on initial mount, ensure polling can start even if
  // useFocusEffect misfires on Android APKs.
  useEffect(() => {
    setIsFocused(true);
    setPhase("scanning");
    api.listEmployees().then(setEmployees).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!permission) requestPermission();
  }, [permission, requestPermission]);

  // scan animation loop
  useEffect(() => {
    if (phase !== "scanning") return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(scanLine, {
          toValue: 1,
          duration: 1600,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(scanLine, {
          toValue: 0,
          duration: 1600,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, {
          toValue: 1,
          duration: 1100,
          useNativeDriver: true,
        }),
        Animated.timing(ringPulse, {
          toValue: 0,
          duration: 1100,
          useNativeDriver: true,
        }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(cornerOpacity, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(cornerOpacity, {
          toValue: 0.4,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [phase, scanLine, ringPulse, cornerOpacity]);

  // Real face match — capture a frame every MATCH_INTERVAL_MS and POST to /api/attendance/match
  useEffect(() => {
    if (!isFocused) return;
    if (phase !== "scanning") return;
    if (!cameraReady) return; // wait until the CameraView surface is ready
    if (!permission?.granted) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled || busyRef.current) return;
      const cam = cameraRef.current;
      if (!cam) return;
      busyRef.current = true;
      setInFlight(true);
      try {
        // NOTE: `shutterSound` and `skipProcessing` are removed. On APK builds
        // `skipProcessing: true` frequently returns a URI whose file isn't
        // fully written when the promise resolves, making the subsequent
        // ImageManipulator.manipulate() step fail silently.
        const pic = await cam.takePictureAsync({
          quality: 0.5,
          base64: false,
        });
        if (cancelled || !pic?.uri) {
          setScanError("Camera did not return a frame. Retrying…");
          return;
        }

        // Downscale to 480px wide so backend HOG detection is fast and payload stays tiny
        const small = await ImageManipulator.manipulateAsync(
          pic.uri,
          [{ resize: { width: 480 } }],
          {
            compress: 0.6,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          }
        );
        if (cancelled || !small.base64) {
          setScanError("Could not compress the captured frame. Retrying…");
          return;
        }

        const res = await api.matchFace({
          image_b64: small.base64,
          type: action,
          threshold: 0.6,
        });
        if (cancelled) return;

        // request succeeded — clear any earlier surfaced error
        setScanError(null);

        setFacesInFrame(res.faces_detected ?? 0);
        // Update box overlay with every response — matched flag decides colour.
        setBoxes((res.matches ?? []).filter((m) => m.box));

        // Iterate all matches, apply per-employee cooldown, then queue new ones
        const successful = (res.matches ?? []).filter(
          (m) => m.matched && m.employee
        );
        if (successful.length === 0) return;

        const now = Date.now();
        const fresh: FaceMatchItem[] = [];
        for (const m of successful) {
          const empId = m.employee!.id;
          const lastAt = cooldownRef.current.get(empId) ?? 0;
          if (now - lastAt < PER_EMPLOYEE_COOLDOWN_MS) continue;
          cooldownRef.current.set(empId, now);
          fresh.push(m);
        }
        if (fresh.length === 0) return;

        // Show the first one immediately, queue the rest
        const [head, ...tail] = fresh;
        setMatched(head.employee);
        setMatchTime(head.attendance?.time ?? "");
        setMatchQueue(tail);
        setPhase("matched");
        try {
          Speech.speak(
            `${head.employee!.name_hi ?? head.employee!.name} की हाजिरी लग गई है`,
            { language: "hi-IN", rate: 0.95 }
          );
        } catch {
          // noop
        }
      } catch (e) {
        // Surface a short error so the user (and QA on APK builds) can see it.
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("match tick failed", e);
        setScanError(`Scan failed: ${msg.slice(0, 80)}`);
      } finally {
        busyRef.current = false;
        setInFlight(false);
      }
    };

    const t = setInterval(tick, MATCH_INTERVAL_MS);
    // fire once immediately
    tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [phase, isFocused, action, cameraReady, permission?.granted]);

  const resumeScan = useCallback(() => {
    try {
      Speech.stop();
    } catch {
      // noop
    }
    // If there are queued matches from a multi-face frame, advance to the next
    // instead of returning to scanning immediately.
    setMatchQueue((q) => {
      if (q.length > 0) {
        const [head, ...tail] = q;
        setMatched(head.employee);
        setMatchTime(head.attendance?.time ?? "");
        // keep phase = "matched" and (re)start auto-dismiss via the effect below
        try {
          if (head.employee) {
            Speech.speak(
              `${head.employee.name_hi ?? head.employee.name} की हाजिरी लग गई है`,
              { language: "hi-IN", rate: 0.95 }
            );
          }
        } catch {
          // noop
        }
        return tail;
      }
      // queue empty → back to live scanning
      setMatched(null);
      setMatchTime("");
      setPhase("scanning");
      return q;
    });
  }, []);

  // Auto-dismiss match modal after MATCH_MODAL_AUTOCLOSE_MS so the flow stays hands-free.
  // Re-arms when `matched` changes (e.g. advancing through a multi-face queue).
  useEffect(() => {
    if (phase !== "matched") return;
    const t = setTimeout(resumeScan, MATCH_MODAL_AUTOCLOSE_MS);
    return () => clearTimeout(t);
  }, [phase, matched, resumeScan]);

  // Clear stale face-boxes if a new frame doesn't arrive within BOX_TTL_MS
  useEffect(() => {
    if (boxes.length === 0) return;
    const t = setTimeout(() => setBoxes([]), BOX_TTL_MS);
    return () => clearTimeout(t);
  }, [boxes]);

  const openEnroll = useCallback(() => {
    setEnrollError(null);
    setEnrollEmp(null);
    setEnrollOpen(true);
  }, []);

  const runEnroll = useCallback(async () => {
    const cam = cameraRef.current;
    if (!cam || !enrollEmp) return;
    setEnrollBusy(true);
    setEnrollError(null);
    try {
      const pic = await cam.takePictureAsync({
        quality: 0.7,
        base64: false,
      });
      if (!pic?.uri) throw new Error("Camera capture failed");
      const small = await ImageManipulator.manipulateAsync(
        pic.uri,
        [{ resize: { width: 640 } }],
        {
          compress: 0.75,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );
      if (!small.base64) throw new Error("Could not encode capture");
      const res = await api.enrollFace(enrollEmp.id, {
        image_b64: small.base64,
        update_photo: true,
      });
      if (!res.ok) throw new Error(res.message || "Enrollment failed");
      // refresh employees list so new photo shows up
      const list = await api.listEmployees();
      setEmployees(list);
      setEnrollOpen(false);
      // reset cooldown for this employee so first scan after enroll punches immediately
      cooldownRef.current.delete(enrollEmp.id);
    } catch (e: unknown) {
      // Backend returns HTTPException with detail — extract friendly message
      let msg =
        e instanceof Error ? e.message : "Enrollment failed. Try again.";
      const jsonStart = msg.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(msg.slice(jsonStart));
          if (typeof parsed?.detail === "string") msg = parsed.detail;
        } catch {
          // keep original
        }
      }
      setEnrollError(msg);
    } finally {
      setEnrollBusy(false);
    }
  }, [enrollEmp]);

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => a.name.localeCompare(b.name)),
    [employees]
  );

  if (!permission) {
    return <View style={styles.permWrap} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permWrap}>
        <StatusBar style="light" />
        <View style={styles.permIcon}>
          <Ionicons name="camera-outline" size={40} color={colors.brand} />
        </View>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permSub}>
          Qaans ERP uses your camera to recognise employee faces and mark
          attendance instantly. No data is uploaded.
        </Text>
        <View style={{ width: "100%", gap: 10, marginTop: 24 }}>
          <PrimaryButton
            testID="grant-camera-permission"
            label="Allow Camera"
            onPress={requestPermission}
            iconRight="camera"
          />
          {!permission.canAskAgain ? (
            <PrimaryButton
              testID="open-settings-button"
              label="Open Settings"
              variant="ghost"
              onPress={() => {
                if (typeof window !== "undefined") {
                  // web fallback - no-op
                }
              }}
            />
          ) : null}
          <PrimaryButton
            testID="cancel-camera-button"
            label="Go Back"
            variant="ghost"
            onPress={() => router.back()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      {isFocused ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          testID="face-camera-view"
          onCameraReady={() => setCameraReady(true)}
          onMountError={(e) => {
            console.warn("camera mount error", e);
            setScanError(
              `Camera failed to start: ${
                (e as { message?: string })?.message ?? "unknown"
              }`
            );
          }}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setCameraLayout({ w: width, h: height });
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.black }]} />
      )}

      {/* Face bounding boxes — drawn on top of the camera preview. Coordinates
          come from the backend (normalized 0..1) so they mirror the last frame
          captured (~1.5s cadence). Front-facing camera preview is horizontally
          mirrored on device but the captured image is NOT, so we flip x for the
          front camera to keep the box on the actual face on screen. */}
      {cameraLayout && boxes.length > 0 ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {boxes.map((b, idx) => {
            const box = b.box!;
            const leftFrac = facing === "front" ? 1 - box.right : box.left;
            const rightFrac = facing === "front" ? 1 - box.left : box.right;
            const x = leftFrac * cameraLayout.w;
            const y = box.top * cameraLayout.h;
            const w = (rightFrac - leftFrac) * cameraLayout.w;
            const h = (box.bottom - box.top) * cameraLayout.h;
            const color = b.matched ? colors.success : "#F59E0B";
            const label = b.matched
              ? b.employee?.name ?? "Match"
              : "Unknown";
            return (
              <View
                key={`box-${idx}-${b.employee?.id ?? "u"}`}
                testID={`face-box-${idx}`}
                style={[
                  styles.faceBox,
                  {
                    left: x,
                    top: y,
                    width: w,
                    height: h,
                    borderColor: color,
                  },
                ]}
              >
                <View
                  style={[
                    styles.faceBoxLabel,
                    { backgroundColor: color },
                  ]}
                >
                  <Ionicons
                    name={b.matched ? "checkmark" : "help"}
                    size={10}
                    color={colors.white}
                  />
                  <Text style={styles.faceBoxLabelText} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {/* darken overlay */}
      <LinearGradient
        colors={["rgba(0,0,0,0.55)", "rgba(0,0,0,0.2)", "rgba(0,0,0,0.85)"]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.topBar} edges={["top"]}>
        <Pressable
          testID="close-attendance-button"
          onPress={() => router.replace("/(tabs)/dashboard")}
          style={styles.iconBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.white} />
        </Pressable>

        <View style={styles.statusPill}>
          {phase === "scanning" && inFlight ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <View style={styles.statusDot} />
          )}
          <Text style={styles.statusText}>
            {phase === "matched" ? "Match found" : "Scanning…"}
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            testID="enroll-face-button"
            onPress={openEnroll}
            style={styles.iconBtn}
            hitSlop={10}
          >
            <Ionicons name="person-add-outline" size={20} color={colors.white} />
          </Pressable>
          <Pressable
            testID="flip-camera-button"
            onPress={() =>
              setFacing((f) => (f === "front" ? "back" : "front"))
            }
            style={styles.iconBtn}
            hitSlop={10}
          >
            <Ionicons name="camera-reverse-outline" size={20} color={colors.white} />
          </Pressable>
        </View>
      </SafeAreaView>

      {scanError ? (
        <View style={styles.errorBanner} testID="scan-error-banner">
          <Ionicons name="warning-outline" size={14} color={colors.white} />
          <Text style={styles.errorBannerText} numberOfLines={2}>
            {scanError}
          </Text>
        </View>
      ) : null}

      {/* Frame */}
      <View style={styles.frameWrap} pointerEvents="none">
        <Animated.View
          style={[
            styles.ring,
            {
              opacity: ringPulse.interpolate({
                inputRange: [0, 1],
                outputRange: [0.15, 0.45],
              }),
              transform: [
                {
                  scale: ringPulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.95, 1.08],
                  }),
                },
              ],
            },
          ]}
        />
        <View style={styles.frame}>
          {/* Corners */}
          {(["tl", "tr", "bl", "br"] as const).map((pos) => (
            <Animated.View
              key={pos}
              style={[
                styles.corner,
                cornerPos[pos],
                { opacity: cornerOpacity },
              ]}
            />
          ))}

          {phase === "scanning" ? (
            <Animated.View
              style={[
                styles.scanLine,
                {
                  transform: [
                    {
                      translateY: scanLine.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, 240],
                      }),
                    },
                  ],
                },
              ]}
            />
          ) : null}
        </View>
        <Text style={styles.frameHint}>
          {phase === "scanning"
            ? "Align your face inside the frame"
            : "Face matched successfully"}
        </Text>
      </View>

      {/* Bottom action row */}
      <View style={styles.bottomBar} pointerEvents="box-none">
        <View style={styles.modeRow}>
          {(["Check-in", "Check-out"] as const).map((m) => {
            const active = action === m;
            return (
              <Pressable
                key={m}
                testID={`mode-${m.toLowerCase()}`}
                onPress={() => setAction(m)}
                style={[styles.modeBtn, active && styles.modeBtnActive]}
              >
                <Ionicons
                  name={m === "Check-in" ? "log-in-outline" : "log-out-outline"}
                  size={16}
                  color={active ? colors.white : "#CBD5E1"}
                />
                <Text
                  style={[styles.modeText, active && { color: colors.white }]}
                >
                  {m}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.bottomHint}>
          {facesInFrame > 0
            ? `${facesInFrame} face${facesInFrame > 1 ? "s" : ""} detected · Auto-punching`
            : `Auto-detecting faces · ${employees.length} employees enrolled`}
        </Text>
      </View>

      {/* Match modal */}
      <Modal visible={phase === "matched" && !!matched} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.matchCard}>
            <View style={styles.matchTopRow}>
              <View style={styles.badgeGreen}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={colors.success}
                />
                <Text style={styles.badgeGreenText}>
                  {matchQueue.length > 0
                    ? `Attendance marked · ${matchQueue.length} more`
                    : "Attendance marked"}
                </Text>
              </View>
              <Pressable
                onPress={resumeScan}
                hitSlop={10}
                testID="close-match-modal"
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.matchAvatarWrap}>
              <Avatar
                photo={matched?.photo}
                name={matched?.name}
                size={112}
              />
              <View style={styles.matchTick}>
                <Ionicons name="checkmark" size={18} color={colors.white} />
              </View>
            </View>

            <Text style={styles.matchName}>{matched?.name}</Text>
            <Text style={styles.matchNameHi}>{matched?.name_hi}</Text>

            <View style={styles.matchMeta}>
              <View style={styles.metaItem}>
                <Ionicons
                  name="id-card-outline"
                  size={14}
                  color={colors.textSecondary}
                />
                <Text style={styles.metaText}>{matched?.code}</Text>
              </View>
              <View style={styles.metaSep} />
              <View style={styles.metaItem}>
                <Ionicons
                  name="briefcase-outline"
                  size={14}
                  color={colors.textSecondary}
                />
                <Text style={styles.metaText}>{matched?.designation ?? "—"}</Text>
              </View>
            </View>

            <View style={styles.matchActionRow}>
              <View style={styles.actionPill}>
                <Ionicons
                  name={
                    action === "Check-in"
                      ? "log-in-outline"
                      : "log-out-outline"
                  }
                  size={14}
                  color={colors.brand}
                />
                <Text style={styles.actionPillText}>{action}</Text>
              </View>
              <View style={styles.timePill}>
                <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                <Text style={styles.timePillText}>
                  {matchTime ||
                    new Date().toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                </Text>
              </View>
            </View>

            <View style={styles.audioHint}>
              <Ionicons
                name="volume-high-outline"
                size={14}
                color={colors.brand}
              />
              <Text style={styles.audioHintText}>
                Announced in Hindi · हाजिरी लग गई है
              </Text>
            </View>

            <PrimaryButton
              testID="continue-scan-button"
              label="Continue Scanning"
              onPress={resumeScan}
              iconRight="scan-outline"
            />
          </View>
        </View>
      </Modal>

      {/* Enroll face modal */}
      <Modal
        visible={enrollOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setEnrollOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.enrollCard}>
            <View style={styles.matchTopRow}>
              <Text style={styles.enrollTitle}>Enroll face</Text>
              <Pressable
                onPress={() => setEnrollOpen(false)}
                hitSlop={10}
                testID="close-enroll-modal"
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.enrollSub}>
              {enrollEmp
                ? "Look directly at the camera in good light, then tap Capture."
                : "Choose the employee to link with the face in front of the camera."}
            </Text>

            {enrollEmp ? (
              <View style={styles.enrollSelected}>
                <Avatar
                  photo={enrollEmp.photo}
                  name={enrollEmp.name}
                  size={48}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.enrollName}>{enrollEmp.name}</Text>
                  <Text style={styles.enrollMeta}>
                    {enrollEmp.code}
                    {enrollEmp.designation ? ` · ${enrollEmp.designation}` : ""}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setEnrollEmp(null)}
                  hitSlop={10}
                  testID="change-enroll-employee"
                >
                  <Text style={styles.changeLink}>Change</Text>
                </Pressable>
              </View>
            ) : (
              <FlatList
                data={sortedEmployees}
                keyExtractor={(item) => item.id}
                style={{ maxHeight: 260, marginTop: 12 }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    testID={`enroll-pick-${item.code}`}
                    onPress={() => setEnrollEmp(item)}
                    style={styles.enrollRow}
                  >
                    <Avatar photo={item.photo} name={item.name} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.enrollName}>{item.name}</Text>
                      <Text style={styles.enrollMeta}>
                        {item.code}
                        {item.designation ? ` · ${item.designation}` : ""}
                      </Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={colors.textSecondary}
                    />
                  </Pressable>
                )}
                ItemSeparatorComponent={() => (
                  <View style={styles.enrollSep} />
                )}
              />
            )}

            {enrollError ? (
              <Text style={styles.enrollErr} testID="enroll-error">
                {enrollError}
              </Text>
            ) : null}

            <View style={{ height: 12 }} />
            <PrimaryButton
              testID="enroll-capture-button"
              label={enrollBusy ? "Enrolling…" : "Capture & Enroll"}
              onPress={runEnroll}
              iconRight="camera"
              disabled={!enrollEmp || enrollBusy}
              loading={enrollBusy}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const cornerPos = {
  tl: { top: -1, left: -1, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 },
  tr: { top: -1, right: -1, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 },
  bl: { bottom: -1, left: -1, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 },
  br: { bottom: -1, right: -1, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 },
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.black },
  permWrap: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
    paddingTop: 48,
    alignItems: "center",
  },
  permIcon: {
    width: 80,
    height: 80,
    borderRadius: 24,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 40,
  },
  permTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 18,
  },
  permSub: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 22,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 4,
    zIndex: 5,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.success,
  },
  statusText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: "700",
  },
  frameWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.brand,
  },
  frame: {
    width: 260,
    height: 260,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  corner: {
    position: "absolute",
    width: 28,
    height: 28,
    borderColor: colors.brand,
  },
  scanLine: {
    position: "absolute",
    left: 10,
    right: 10,
    height: 2,
    backgroundColor: colors.brand,
    shadowColor: colors.brand,
    shadowOpacity: 1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    borderRadius: 2,
  },
  frameHint: {
    color: colors.white,
    fontSize: 14,
    marginTop: 24,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 32,
    alignItems: "center",
    paddingHorizontal: 20,
  },
  modeRow: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 999,
    padding: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  modeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  modeBtnActive: { backgroundColor: colors.brand },
  modeText: {
    color: "#CBD5E1",
    fontSize: 13,
    fontWeight: "700",
  },
  bottomHint: {
    color: "#E2E8F0",
    fontSize: 12,
    marginTop: 12,
    fontWeight: "500",
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.6)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  matchCard: {
    width: "100%",
    backgroundColor: colors.white,
    borderRadius: radius.xxl,
    padding: 20,
    ...shadow.strong,
  },
  matchTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  badgeGreen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.successSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeGreenText: { color: colors.success, fontWeight: "700", fontSize: 12 },
  matchAvatarWrap: {
    alignSelf: "center",
    marginTop: 16,
    position: "relative",
  },
  matchAvatar: {
    width: 96,
    height: 96,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: colors.successSoft,
  },
  matchTick: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.white,
  },
  matchName: {
    textAlign: "center",
    marginTop: 14,
    fontSize: 22,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.4,
  },
  matchNameHi: {
    textAlign: "center",
    marginTop: 2,
    fontSize: 18,
    color: colors.brand,
    fontWeight: "700",
  },
  matchMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
    gap: 8,
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.textSecondary, fontSize: 12, fontWeight: "500" },
  metaSep: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.borderStrong,
  },
  matchActionRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
  },
  actionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.brandSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  actionPillText: { color: colors.brand, fontWeight: "700", fontSize: 13 },
  timePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  timePillText: {
    color: colors.textSecondary,
    fontWeight: "700",
    fontSize: 13,
  },
  audioHint: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 14,
    marginBottom: 18,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.brandSoft,
    borderRadius: radius.md,
    alignSelf: "center",
  },
  audioHintText: {
    color: colors.brand,
    fontSize: 12,
    fontWeight: "600",
  },
  enrollCard: {
    width: "100%",
    backgroundColor: colors.white,
    borderRadius: radius.xxl,
    padding: 20,
    ...shadow.strong,
  },
  enrollTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  enrollSub: {
    marginTop: 6,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  enrollRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  enrollSep: {
    height: 1,
    backgroundColor: colors.borderStrong,
    opacity: 0.15,
    marginLeft: 52,
  },
  enrollAvatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: colors.borderStrong,
  },
  enrollAvatarSm: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: colors.borderStrong,
  },
  enrollSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 14,
    padding: 12,
    backgroundColor: colors.brandSoft,
    borderRadius: radius.lg,
  },
  enrollName: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  enrollMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  changeLink: {
    color: colors.brand,
    fontWeight: "700",
    fontSize: 13,
  },
  enrollErr: {
    marginTop: 10,
    color: colors.danger ?? "#DC2626",
    fontSize: 13,
    fontWeight: "600",
  },
  faceBox: {
    position: "absolute",
    borderWidth: 2.5,
    borderRadius: 10,
    // subtle inner glow via shadow-like border style; RN doesn't do glow,
    // we compensate with a bright colour.
  },
  errorBanner: {
    position: "absolute",
    top: 96,
    left: 16,
    right: 16,
    backgroundColor: "rgba(220, 38, 38, 0.92)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 20,
  },
  errorBannerText: {
    flex: 1,
    color: colors.white,
    fontSize: 12,
    fontWeight: "600",
  },
  faceBoxLabel: {
    position: "absolute",
    top: -22,
    left: -1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 200,
  },
  faceBoxLabelText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
  },
});
