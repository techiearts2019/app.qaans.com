import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Image } from "expo-image";
import * as ImageManipulator from "expo-image-manipulator";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { DatePickerField } from "@/src/components/DatePickerField";
import { DropdownField, TextField } from "@/src/components/FormField";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { Toast } from "@/src/components/Toast";
import {
  designations,
  genders,
  maritalStatuses,
  skills,
} from "@/src/data/mockData";
import { api, Project } from "@/src/lib/api";
import { colors, radius } from "@/src/theme/colors";

type FormState = {
  photo?: string;
  empCode: string;
  designation?: string;
  skill?: string;
  project?: string;
  name: string;
  gender?: string;
  marital?: string;
  dob?: string;
  fatherName: string;
  nominee: string;
  primaryMobile: string;
  altMobile: string;
  email: string;
  doj?: string;
  doe?: string;
  currentAddr: string;
  permanentAddr: string;
  aadhaar: string;
  pan: string;
  uan: string;
  esi: string;
};

const init: FormState = {
  empCode: "",
  name: "",
  fatherName: "",
  nominee: "",
  primaryMobile: "",
  altMobile: "",
  email: "",
  currentAddr: "",
  permanentAddr: "",
  aadhaar: "",
  pan: "",
  uan: "",
  esi: "",
};

export default function AddEmployee() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(init);
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<0 | 1 | 2>(0);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: "success" | "error" }>({
    visible: false,
    message: "",
    type: "success",
  });

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const sectionValid = (idx: number) => {
    if (idx === 0) {
      return (
        !!form.photo &&
        !!form.empCode &&
        !!form.designation &&
        !!form.skill &&
        !!form.project &&
        !!form.name &&
        !!form.gender &&
        !!form.marital &&
        !!form.dob &&
        !!form.fatherName &&
        !!form.primaryMobile &&
        !!form.doj
      );
    }
    if (idx === 1) {
      return !!form.currentAddr && !!form.permanentAddr;
    }
    return !!form.aadhaar;
  };

  const allValid = sectionValid(0) && sectionValid(1) && sectionValid(2);

  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) return;
    }
    setCameraOpen(true);
  };

  const capture = async () => {
    try {
      if (cameraRef.current) {
        // NOTE: `skipProcessing` is removed — on Android APKs the URI it
        // returns is not fully written when the promise resolves, which
        // breaks the base64 conversion below.
        const pic = await cameraRef.current.takePictureAsync({
          quality: 0.4,
          base64: false,
        });
        if (pic?.uri) set("photo", pic.uri);
      }
    } catch {
      // ignore
    }
    setCameraOpen(false);
  };

  /** Convert a captured photo URI to what the backend expects.
   *
   *  - http(s):// URIs are already reachable from the server, pass as `photo`.
   *  - Everything else (file://, content://, ph://, or a bare path) is
   *    downscaled + JPEG-compressed on-device and sent as base64 in
   *    `photo_b64`. The backend then stores it as a `data:image/jpeg;base64,…`
   *    URL AND computes the 128-d face encoding server-side.
   *
   *  Uses the legacy `manipulateAsync` API which is more reliable on
   *  Android APKs than the new fluent `manipulate().renderAsync()` chain
   *  (the new API silently returns undefined `base64` on some devices).
   */
  const encodePhotoForUpload = async (
    uri: string
  ): Promise<{ photo?: string; photo_b64?: string }> => {
    if (!uri) throw new Error("photo URI is empty");

    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      return { photo: uri };
    }
    if (uri.startsWith("data:")) {
      // "data:image/jpeg;base64,ABC" → strip prefix; backend re-adds it
      const b64 = uri.split(",", 2)[1] ?? "";
      if (!b64) throw new Error("photo data URL has empty base64 body");
      return { photo_b64: b64 };
    }

    // local URI (file://, content://, ph://, bare path). Downscale to 640px
    // wide + JPEG q=0.7, then base64 encode.
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 640 } }],
      {
        compress: 0.7,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    if (!result.base64) {
      throw new Error(
        "expo-image-manipulator returned no base64 payload for the captured photo"
      );
    }
    return { photo_b64: result.base64 };
  };

  const onSave = async () => {
    if (!allValid) {
      setToast({
        visible: true,
        message: "Please fill all required fields",
        type: "error",
      });
      return;
    }
    const projMatch = projects.find((p) => p.name === form.project);
    setSaving(true);
    try {
      // Photo is REQUIRED (validated by sectionValid(0)). We must succeed at
      // encoding it before hitting the create-employee endpoint — otherwise
      // we'd end up with a record whose photo/face_encoding are null.
      let photoParts: { photo?: string; photo_b64?: string };
      try {
        photoParts = await encodePhotoForUpload(form.photo as string);
      } catch (encErr) {
        console.warn("photo encoding failed", encErr);
        setToast({
          visible: true,
          message: `Could not process photo: ${
            encErr instanceof Error ? encErr.message : "unknown error"
          }. Re-capture and try again.`,
          type: "error",
        });
        setSaving(false);
        return;
      }
      if (!photoParts.photo && !photoParts.photo_b64) {
        setToast({
          visible: true,
          message:
            "Photo did not encode correctly. Please retake the photo.",
          type: "error",
        });
        setSaving(false);
        return;
      }
      await api.createEmployee({
        name: form.name,
        code: form.empCode,
        designation: form.designation,
        skill: form.skill,
        gender: form.gender,
        marital_status: form.marital,
        dob: form.dob,
        father_name: form.fatherName,
        nominee: form.nominee || undefined,
        primary_mobile: form.primaryMobile,
        alt_mobile: form.altMobile || undefined,
        email: form.email || undefined,
        date_of_joining: form.doj,
        date_of_exit: form.doe,
        current_address: form.currentAddr,
        permanent_address: form.permanentAddr,
        aadhaar: form.aadhaar,
        pan: form.pan || undefined,
        uan: form.uan || undefined,
        esi: form.esi || undefined,
        status: projMatch ? "Active" : "No Allocation",
        ...photoParts,
        project_id: projMatch?.id,
      });
      setToast({
        visible: true,
        message: `${form.name} added successfully`,
        type: "success",
      });
      setTimeout(() => router.replace("/employees"), 900);
    } catch (e) {
      console.warn("create employee failed", e);
      // Surface the backend's 422 friendly detail if present (bad photo)
      let msg = "Failed to save employee. Try again.";
      const raw = e instanceof Error ? e.message : "";
      const jsonStart = raw.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(jsonStart));
          if (typeof parsed?.detail === "string") msg = parsed.detail;
        } catch {
          // keep default
        }
      }
      setToast({ visible: true, message: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          testID="add-employee-back-button"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Add Employee</Text>
          <Text style={styles.subtitle}>Step {activeSection + 1} of 3</Text>
        </View>
      </View>

      <View style={styles.tabsRow}>
        {["Personal", "Contact", "Documents"].map((label, i) => {
          const active = i === activeSection;
          const done = i < activeSection;
          return (
            <Pressable
              key={label}
              testID={`section-tab-${i}`}
              onPress={() => setActiveSection(i as 0 | 1 | 2)}
              style={styles.tabBtn}
            >
              <View
                style={[
                  styles.tabDot,
                  active && { backgroundColor: colors.brand },
                  done && {
                    backgroundColor: colors.success,
                    borderColor: colors.success,
                  },
                ]}
              >
                {done ? (
                  <Ionicons name="checkmark" size={12} color={colors.white} />
                ) : (
                  <Text
                    style={[
                      styles.tabDotText,
                      active && { color: colors.white },
                    ]}
                  >
                    {i + 1}
                  </Text>
                )}
              </View>
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {label}
              </Text>
              {i < 2 ? (
                <View
                  style={[
                    styles.tabSep,
                    (done || active) && { backgroundColor: colors.brand },
                  ]}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        bottomOffset={100}
        showsVerticalScrollIndicator={false}
      >
        {activeSection === 0 ? (
          <>
            <Text style={styles.sectionTitle}>Personal Details</Text>

            <View style={styles.photoSection}>
              <Pressable
                testID="employee-photo-button"
                onPress={openCamera}
                style={styles.photoBtn}
              >
                {form.photo ? (
                  <View style={styles.photoFill}>
                    <Image
                      source={{ uri: form.photo }}
                      style={styles.photoFill}
                    />
                    <View style={[styles.photoFill, styles.photoOverlay]}>
                      <Ionicons
                        name="camera"
                        size={18}
                        color={colors.white}
                      />
                    </View>
                  </View>
                ) : (
                  <View style={styles.photoEmpty}>
                    <Ionicons
                      name="camera-outline"
                      size={28}
                      color={colors.brand}
                    />
                  </View>
                )}
              </Pressable>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.photoTitle}>
                  {form.photo ? "Photo captured" : "Capture employee photo"}
                </Text>
                <Text style={styles.photoHelp}>
                  Used for face attendance recognition. Required.
                </Text>
              </View>
            </View>

            <TextField
              label="Employee Code"
              required
              value={form.empCode}
              onChangeText={(v) => set("empCode", v)}
              placeholder="e.g. DHD-1050"
              autoCapitalize="characters"
              testID="emp-code-input"
            />
            <DropdownField
              label="Designation"
              required
              value={form.designation}
              options={designations}
              onSelect={(v) => set("designation", v)}
              testID="designation-dropdown"
            />
            <DropdownField
              label="Skill"
              required
              value={form.skill}
              options={skills}
              onSelect={(v) => set("skill", v)}
              testID="skill-dropdown"
            />
            <DropdownField
              label="Project Allocation"
              required
              value={form.project}
              options={["No Allocation", ...projects.map((p) => p.name)]}
              onSelect={(v) => set("project", v)}
              testID="project-dropdown"
              placeholder="Allocate to a project"
            />
            <TextField
              label="Employee Name"
              required
              value={form.name}
              onChangeText={(v) => set("name", v)}
              placeholder="Full name"
              testID="emp-name-input"
            />
            <DropdownField
              label="Gender"
              required
              value={form.gender}
              options={genders}
              onSelect={(v) => set("gender", v)}
              testID="gender-dropdown"
            />
            <DropdownField
              label="Marital Status"
              required
              value={form.marital}
              options={maritalStatuses}
              onSelect={(v) => set("marital", v)}
              testID="marital-dropdown"
            />
            <DatePickerField
              label="Date of Birth"
              required
              value={form.dob}
              onChange={(v) => set("dob", v)}
              testID="dob-picker"
            />
            <TextField
              label="Father's Name"
              required
              value={form.fatherName}
              onChangeText={(v) => set("fatherName", v)}
              placeholder="Father's full name"
              testID="father-name-input"
            />
            <TextField
              label="Nominee Name"
              value={form.nominee}
              onChangeText={(v) => set("nominee", v)}
              placeholder="Optional"
              testID="nominee-input"
            />
            <TextField
              label="Primary Mobile"
              required
              value={form.primaryMobile}
              onChangeText={(v) => set("primaryMobile", v)}
              placeholder="+91 ..."
              keyboardType="phone-pad"
              testID="primary-mobile-input"
            />
            <TextField
              label="Alternate Mobile"
              value={form.altMobile}
              onChangeText={(v) => set("altMobile", v)}
              placeholder="Optional"
              keyboardType="phone-pad"
              testID="alt-mobile-input"
            />
            <TextField
              label="Email"
              value={form.email}
              onChangeText={(v) => set("email", v)}
              placeholder="Optional"
              keyboardType="email-address"
              autoCapitalize="none"
              testID="email-input"
            />
            <DatePickerField
              label="Date of Joining"
              required
              value={form.doj}
              onChange={(v) => set("doj", v)}
              testID="doj-picker"
            />
            <DatePickerField
              label="Date of Exit"
              value={form.doe}
              onChange={(v) => set("doe", v)}
              testID="doe-picker"
            />
          </>
        ) : null}

        {activeSection === 1 ? (
          <>
            <Text style={styles.sectionTitle}>Communication Details</Text>
            <TextField
              label="Current Address"
              required
              value={form.currentAddr}
              onChangeText={(v) => set("currentAddr", v)}
              placeholder="House no, street, city, state"
              multiline
              testID="current-address-input"
            />
            <TextField
              label="Permanent Address"
              required
              value={form.permanentAddr}
              onChangeText={(v) => set("permanentAddr", v)}
              placeholder="House no, street, city, state"
              multiline
              testID="permanent-address-input"
            />
            <Pressable
              testID="copy-address-button"
              onPress={() =>
                setForm((s) => ({ ...s, permanentAddr: s.currentAddr }))
              }
              style={styles.copyBtn}
            >
              <Ionicons
                name="copy-outline"
                size={16}
                color={colors.brand}
              />
              <Text style={styles.copyText}>Copy from current address</Text>
            </Pressable>
          </>
        ) : null}

        {activeSection === 2 ? (
          <>
            <Text style={styles.sectionTitle}>Document Details</Text>
            <TextField
              label="Aadhaar Number"
              required
              value={form.aadhaar}
              onChangeText={(v) => set("aadhaar", v)}
              placeholder="XXXX XXXX XXXX"
              keyboardType="number-pad"
              testID="aadhaar-input"
            />
            <TextField
              label="PAN Number"
              value={form.pan}
              onChangeText={(v) => set("pan", v)}
              placeholder="ABCDE1234F"
              autoCapitalize="characters"
              testID="pan-input"
            />
            <TextField
              label="UAN Number"
              value={form.uan}
              onChangeText={(v) => set("uan", v)}
              placeholder="12-digit UAN"
              keyboardType="number-pad"
              testID="uan-input"
            />
            <TextField
              label="ESI Number"
              value={form.esi}
              onChangeText={(v) => set("esi", v)}
              placeholder="ESI number"
              testID="esi-input"
            />
          </>
        ) : null}

        <View style={{ height: 16 }} />
      </KeyboardAwareScrollView>

      <View style={styles.footer}>
        {activeSection > 0 ? (
          <PrimaryButton
            testID="prev-section-button"
            label="Back"
            variant="ghost"
            onPress={() =>
              setActiveSection((s) => Math.max(0, s - 1) as 0 | 1 | 2)
            }
            style={{ flex: 1 }}
          />
        ) : null}
        {activeSection < 2 ? (
          <PrimaryButton
            testID="next-section-button"
            label="Continue"
            onPress={() =>
              setActiveSection((s) => Math.min(2, s + 1) as 0 | 1 | 2)
            }
            iconRight="arrow-forward"
            style={{ flex: 1 }}
          />
        ) : (
          <PrimaryButton
            testID="save-employee-button"
            label="Add Employee"
            onPress={onSave}
            loading={saving}
            iconRight="checkmark"
            style={{ flex: 1 }}
          />
        )}
      </View>

      <Modal
        visible={cameraOpen}
        animationType="slide"
        onRequestClose={() => setCameraOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.black }}>
          {permission?.granted ? (
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="front"
            />
          ) : null}
          <SafeAreaView edges={["top"]} style={styles.camTop}>
            <Pressable
              onPress={() => setCameraOpen(false)}
              style={styles.camClose}
              hitSlop={10}
              testID="camera-close-button"
            >
              <Ionicons name="close" size={22} color={colors.white} />
            </Pressable>
            <Text style={styles.camTitle}>Capture Photo</Text>
            <View style={{ width: 40 }} />
          </SafeAreaView>
          <View style={styles.camFrame} pointerEvents="none">
            <View style={styles.camOval} />
            <Text style={styles.camHint}>Align face inside the oval</Text>
          </View>
          <View style={styles.camBottom}>
            <Pressable
              testID="camera-capture-button"
              onPress={capture}
              style={styles.shutter}
            >
              <View style={styles.shutterInner} />
            </Pressable>
          </View>
        </View>
      </Modal>

      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast({ visible: false, message: "", type: "success" })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: "center",
  },
  tabBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  tabDot: {
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  tabDotText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  tabLabelActive: { color: colors.textPrimary },
  tabSep: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border,
    marginHorizontal: 4,
    borderRadius: 2,
  },

  scroll: { padding: 20, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.textPrimary,
    marginBottom: 14,
  },

  photoSection: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
    padding: 14,
    backgroundColor: colors.brandSoft,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: "#DBEAFE",
  },
  photoBtn: {
    width: 72,
    height: 72,
    borderRadius: 999,
    overflow: "hidden",
  },
  photoEmpty: {
    width: 72,
    height: 72,
    borderRadius: 999,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.white,
  },
  photoFill: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  photoOverlay: {
    position: "absolute",
    backgroundColor: "rgba(15,23,42,0.45)",
  },
  photoTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  photoHelp: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },

  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.brandSoft,
    borderRadius: 999,
  },
  copyText: { fontSize: 12, fontWeight: "700", color: colors.brand },

  footer: {
    flexDirection: "row",
    padding: 16,
    paddingBottom: 24,
    gap: 10,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  camTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  camClose: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  camTitle: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 15,
  },
  camFrame: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  camOval: {
    width: 240,
    height: 300,
    borderRadius: 200,
    borderWidth: 3,
    borderColor: colors.white,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  camHint: {
    marginTop: 20,
    color: colors.white,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  camBottom: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 999,
    backgroundColor: colors.white,
  },
});
