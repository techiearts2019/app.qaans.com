import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/src/components/Avatar";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { api, Employee, EmployeeStatus, Project } from "@/src/lib/api";
import { colors, radius, shadow } from "@/src/theme/colors";

const STATUSES: EmployeeStatus[] = ["Active", "No Allocation", "Inactive"];

type EditForm = {
  photo?: string; // may be http(s), data URL, or file:// (fresh capture)
  photoDirty: boolean; // set when user re-captures a photo in this session
  name: string;
  code: string;
  designation: string;
  skill: string;
  gender: string;
  marital_status: string;
  dob: string;
  father_name: string;
  nominee: string;
  primary_mobile: string;
  alt_mobile: string;
  email: string;
  date_of_joining: string;
  date_of_exit: string;
  current_address: string;
  permanent_address: string;
  aadhaar: string;
  pan: string;
  uan: string;
  esi: string;
  status: EmployeeStatus;
  project_id: string;
};

const fromEmployee = (e: Employee): EditForm => ({
  photo: e.photo ?? undefined,
  photoDirty: false,
  name: e.name ?? "",
  code: e.code ?? "",
  designation: e.designation ?? "",
  skill: e.skill ?? "",
  gender: e.gender ?? "",
  marital_status: e.marital_status ?? "",
  dob: e.dob ?? "",
  father_name: e.father_name ?? "",
  nominee: e.nominee ?? "",
  primary_mobile: e.primary_mobile ?? "",
  alt_mobile: e.alt_mobile ?? "",
  email: e.email ?? "",
  date_of_joining: e.date_of_joining ?? "",
  date_of_exit: e.date_of_exit ?? "",
  current_address: e.current_address ?? "",
  permanent_address: e.permanent_address ?? "",
  aadhaar: e.aadhaar ?? "",
  pan: e.pan ?? "",
  uan: e.uan ?? "",
  esi: e.esi ?? "",
  status: (e.status as EmployeeStatus) ?? "Active",
  project_id: e.project_id ?? "",
});

export default function EditEmployee() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("front");
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [toast, setToast] = useState<{
    visible: boolean;
    message: string;
    type: "success" | "error";
  }>({ visible: false, message: "", type: "success" });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [emp, projs] = await Promise.all([
          api.getEmployee(id),
          api.listProjects(),
        ]);
        if (cancelled) return;
        setForm(fromEmployee(emp));
        setProjects(projs);
      } catch {
        if (cancelled) return;
        setToast({
          visible: true,
          message: "Could not load employee",
          type: "error",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!toast.visible) return;
    const t = setTimeout(
      () => setToast((prev) => ({ ...prev, visible: false })),
      2400
    );
    return () => clearTimeout(t);
  }, [toast.visible]);

  const set = <K extends keyof EditForm>(k: K, v: EditForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const openCamera = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setToast({
          visible: true,
          message: "Camera permission required",
          type: "error",
        });
        return;
      }
    }
    setCameraOpen(true);
  };

  const capturePhoto = async () => {
    try {
      if (cameraRef.current) {
        const pic = await cameraRef.current.takePictureAsync({
          quality: 0.5,
          base64: false,
        });
        if (pic?.uri && form) {
          setForm({ ...form, photo: pic.uri, photoDirty: true });
        }
      }
    } catch {
      // ignore
    }
    setCameraOpen(false);
  };

  const encodePhotoIfLocal = async (
    uri: string
  ): Promise<{ photo?: string; photo_b64?: string }> => {
    if (!uri) return {};
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      return { photo: uri };
    }
    if (uri.startsWith("data:")) {
      const b64 = uri.split(",", 2)[1] ?? "";
      if (!b64) throw new Error("photo data URL has empty base64 body");
      return { photo_b64: b64 };
    }
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 640 } }],
      {
        compress: 0.7,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    if (!result.base64)
      throw new Error("expo-image-manipulator returned no base64");
    return { photo_b64: result.base64 };
  };

  const onSave = async () => {
    if (!form || !id) return;
    if (!form.name.trim() || !form.code.trim()) {
      setToast({
        visible: true,
        message: "Name and Employee code are required",
        type: "error",
      });
      return;
    }
    setSaving(true);
    try {
      let photoParts: { photo?: string; photo_b64?: string } = {};
      if (form.photoDirty && form.photo) {
        try {
          photoParts = await encodePhotoIfLocal(form.photo);
        } catch (encErr) {
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
      }

      await api.updateEmployee(id, {
        name: form.name,
        code: form.code,
        designation: form.designation || undefined,
        skill: form.skill || undefined,
        gender: form.gender || undefined,
        marital_status: form.marital_status || undefined,
        dob: form.dob || undefined,
        father_name: form.father_name || undefined,
        nominee: form.nominee || undefined,
        primary_mobile: form.primary_mobile || undefined,
        alt_mobile: form.alt_mobile || undefined,
        email: form.email || undefined,
        date_of_joining: form.date_of_joining || undefined,
        date_of_exit: form.date_of_exit || undefined,
        current_address: form.current_address || undefined,
        permanent_address: form.permanent_address || undefined,
        aadhaar: form.aadhaar || undefined,
        pan: form.pan || undefined,
        uan: form.uan || undefined,
        esi: form.esi || undefined,
        status: form.status,
        project_id: form.project_id,
        ...photoParts,
      });
      setToast({
        visible: true,
        message: `${form.name} updated`,
        type: "success",
      });
      setTimeout(() => router.replace("/employees"), 900);
    } catch (e) {
      let msg = "Failed to update employee. Try again.";
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

  const onDelete = () => {
    if (!id || !form) return;
    Alert.alert(
      "Delete employee?",
      `${form.name} will be permanently removed along with attendance & salary history.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await api.deleteEmployee(id);
              router.replace("/employees");
            } catch (e) {
              setToast({
                visible: true,
                message: `Could not delete: ${
                  e instanceof Error ? e.message : "unknown error"
                }`,
                type: "error",
              });
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  if (loading || !form) {
    return (
      <SafeAreaView style={styles.center} edges={["top"]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </SafeAreaView>
    );
  }

  if (cameraOpen) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.black }}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={cameraFacing}
        />
        <SafeAreaView edges={["top"]} style={styles.cameraTop}>
          <Pressable
            style={styles.iconBtn}
            onPress={() => setCameraOpen(false)}
            hitSlop={10}
          >
            <Ionicons name="close" size={22} color={colors.white} />
          </Pressable>
          <Text style={styles.cameraTitle}>Update photo</Text>
          <Pressable
            style={styles.iconBtn}
            onPress={() =>
              setCameraFacing((f) => (f === "front" ? "back" : "front"))
            }
            hitSlop={10}
          >
            <Ionicons
              name="camera-reverse-outline"
              size={22}
              color={colors.white}
            />
          </Pressable>
        </SafeAreaView>
        <SafeAreaView edges={["bottom"]} style={styles.cameraBottom}>
          <Pressable
            style={styles.shutter}
            onPress={capturePhoto}
            testID="edit-capture-shutter"
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtnDark}
          hitSlop={10}
          testID="edit-back-button"
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Edit Employee</Text>
        <Pressable
          onPress={onDelete}
          style={[styles.iconBtnDark, deleting && { opacity: 0.5 }]}
          hitSlop={10}
          disabled={deleting}
          testID="edit-delete-button"
        >
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {/* Photo */}
          <View style={styles.photoWrap}>
            <Avatar photo={form.photo} name={form.name} size={110} />
            <Pressable
              style={styles.photoBtn}
              onPress={openCamera}
              testID="edit-open-camera"
            >
              <Ionicons name="camera" size={16} color={colors.white} />
              <Text style={styles.photoBtnText}>Change photo</Text>
            </Pressable>
            {form.photoDirty ? (
              <Text style={styles.photoHint}>
                New photo captured — save to update
              </Text>
            ) : null}
          </View>

          {/* Basic */}
          <Section title="Basic details">
            <Field
              label="Name *"
              value={form.name}
              onChangeText={(v) => set("name", v)}
              testID="edit-field-name"
            />
            <Field
              label="Employee code *"
              value={form.code}
              onChangeText={(v) => set("code", v)}
              testID="edit-field-code"
            />
            <Field
              label="Designation"
              value={form.designation}
              onChangeText={(v) => set("designation", v)}
            />
            <Field
              label="Skill"
              value={form.skill}
              onChangeText={(v) => set("skill", v)}
            />
            <Field
              label="Gender"
              value={form.gender}
              onChangeText={(v) => set("gender", v)}
            />
            <Field
              label="Date of birth"
              value={form.dob}
              onChangeText={(v) => set("dob", v)}
              placeholder="e.g. 15 Aug 1988"
            />
          </Section>

          {/* Contact */}
          <Section title="Contact">
            <Field
              label="Primary mobile"
              value={form.primary_mobile}
              onChangeText={(v) => set("primary_mobile", v)}
              keyboardType="phone-pad"
            />
            <Field
              label="Alternate mobile"
              value={form.alt_mobile}
              onChangeText={(v) => set("alt_mobile", v)}
              keyboardType="phone-pad"
            />
            <Field
              label="Email"
              value={form.email}
              onChangeText={(v) => set("email", v)}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Field
              label="Current address"
              value={form.current_address}
              onChangeText={(v) => set("current_address", v)}
              multiline
            />
            <Field
              label="Permanent address"
              value={form.permanent_address}
              onChangeText={(v) => set("permanent_address", v)}
              multiline
            />
          </Section>

          {/* Government IDs */}
          <Section title="Documents">
            <Field
              label="Aadhaar"
              value={form.aadhaar}
              onChangeText={(v) => set("aadhaar", v)}
              keyboardType="number-pad"
            />
            <Field
              label="PAN"
              value={form.pan}
              onChangeText={(v) => set("pan", v)}
              autoCapitalize="characters"
            />
            <Field
              label="UAN"
              value={form.uan}
              onChangeText={(v) => set("uan", v)}
            />
            <Field
              label="ESI"
              value={form.esi}
              onChangeText={(v) => set("esi", v)}
            />
          </Section>

          {/* Family */}
          <Section title="Family">
            <Field
              label="Father's name"
              value={form.father_name}
              onChangeText={(v) => set("father_name", v)}
            />
            <Field
              label="Nominee"
              value={form.nominee}
              onChangeText={(v) => set("nominee", v)}
            />
            <Field
              label="Marital status"
              value={form.marital_status}
              onChangeText={(v) => set("marital_status", v)}
            />
          </Section>

          {/* Employment */}
          <Section title="Employment">
            <Field
              label="Date of joining"
              value={form.date_of_joining}
              onChangeText={(v) => set("date_of_joining", v)}
              placeholder="e.g. 01 Jan 2025"
            />
            <Field
              label="Date of exit"
              value={form.date_of_exit}
              onChangeText={(v) => set("date_of_exit", v)}
              placeholder="e.g. 01 Jan 2026"
            />

            <Text style={styles.label}>Status</Text>
            <View style={styles.chipRow}>
              {STATUSES.map((s) => {
                const active = form.status === s;
                return (
                  <Pressable
                    key={s}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => set("status", s)}
                    testID={`edit-status-${s.replace(/\s+/g, "-").toLowerCase()}`}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>Project</Text>
            <View style={styles.chipRow}>
              <Pressable
                style={[
                  styles.chip,
                  form.project_id === "" && styles.chipActive,
                ]}
                onPress={() => set("project_id", "")}
                testID="edit-project-none"
              >
                <Text
                  style={[
                    styles.chipText,
                    form.project_id === "" && styles.chipTextActive,
                  ]}
                >
                  Unallocated
                </Text>
              </Pressable>
              {projects.map((p) => {
                const active = form.project_id === p.id;
                return (
                  <Pressable
                    key={p.id}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => set("project_id", p.id)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <View style={{ height: 12 }} />
          <PrimaryButton
            testID="edit-save-button"
            label={saving ? "Saving…" : "Save changes"}
            onPress={onSave}
            iconRight="checkmark"
            loading={saving}
            disabled={saving}
          />
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {toast.visible ? (
        <View
          style={[
            styles.toast,
            toast.type === "success" ? styles.toastOk : styles.toastErr,
          ]}
          testID="edit-toast"
        >
          <Ionicons
            name={
              toast.type === "success" ? "checkmark-circle" : "warning"
            }
            size={16}
            color={colors.white}
          />
          <Text style={styles.toastText}>{toast.message}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */
type FieldProps = React.ComponentProps<typeof TextInput> & {
  label: string;
};

function Field({ label, style, ...rest }: FieldProps) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, rest.multiline && styles.inputMulti, style]}
        placeholderTextColor={colors.textMuted}
        {...rest}
      />
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ */
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "800",
    color: colors.textPrimary,
    textAlign: "center",
  },
  iconBtnDark: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
  },
  body: {
    padding: 20,
    paddingBottom: 40,
  },
  photoWrap: {
    alignItems: "center",
    paddingVertical: 20,
    gap: 12,
  },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.brand,
    borderRadius: 999,
  },
  photoBtnText: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 13,
  },
  photoHint: {
    fontSize: 12,
    color: colors.brand,
    fontWeight: "600",
  },
  section: {
    marginTop: 18,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    ...shadow.card,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.textPrimary,
    marginBottom: 12,
  },
  fieldWrap: { marginBottom: 12 },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 6,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceAlt,
  },
  inputMulti: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  chipTextActive: { color: colors.white },
  cameraTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  cameraTitle: { color: colors.white, fontWeight: "800", fontSize: 16 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  cameraBottom: {
    position: "absolute",
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: colors.white,
  },
  toast: {
    position: "absolute",
    top: 80,
    left: 16,
    right: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    ...shadow.strong,
  },
  toastOk: { backgroundColor: colors.success },
  toastErr: { backgroundColor: colors.danger },
  toastText: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 13,
    flex: 1,
  },
});
