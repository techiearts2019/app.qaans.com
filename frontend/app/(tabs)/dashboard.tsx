import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  api,
  AttendanceEntry,
  Employee,
  Supervisor,
} from "@/src/lib/api";
import { Avatar } from "@/src/components/Avatar";
import { colors, radius, shadow } from "@/src/theme/colors";

const FEATURES: {
  key: string;
  title: string;
  icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap;
  bg: string;
  fg: string;
  path: string;
  badge?: string;
}[] = [
  {
    key: "face",
    title: "Face Attendance",
    icon: "scan-circle",
    bg: colors.brand,
    fg: colors.white,
    path: "/(tabs)/attendance",
    badge: "Live",
  },
  {
    key: "add",
    title: "Add Employee",
    icon: "person-add",
    bg: "#ECFDF5",
    fg: colors.success,
    path: "/employees/add",
  },
  {
    key: "list",
    title: "Employees",
    icon: "people",
    bg: "#EFF6FF",
    fg: colors.brand,
    path: "/employees",
  },
  {
    key: "projects",
    title: "Project Allocation",
    icon: "briefcase",
    bg: "#E0F2FE",
    fg: "#0369A1",
    path: "/projects",
  },
  {
    key: "records",
    title: "Attendance Records",
    icon: "calendar",
    bg: "#FEF3C7",
    fg: "#B45309",
    path: "/attendance-records",
  },
  {
    key: "salary",
    title: "Salary Records",
    icon: "wallet",
    bg: "#F3E8FF",
    fg: "#7C3AED",
    path: "/salary-records",
  },
];

export default function Dashboard() {
  const router = useRouter();
  const [supervisor, setSupervisor] = useState<Supervisor | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [todayAttendance, setTodayAttendance] = useState<AttendanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sup, emps, att] = await Promise.all([
        api.supervisor(),
        api.listEmployees(),
        api.todayAttendance(),
      ]);
      setSupervisor(sup);
      setEmployees(emps);
      setTodayAttendance(att);
    } catch (e) {
      console.warn("Dashboard load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const presentToday = todayAttendance.length;
  const totalEmployees = employees.length;
  const greeting = getGreeting();

  if (loading || !supervisor) {
    return (
      <View style={[styles.container, styles.loadingCenter]}>
        <ActivityIndicator color={colors.brand} />
        <Text style={styles.loadingText}>Loading dashboard…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="dashboard-screen">
      <StatusBar style="light" />

      <LinearGradient
        colors={[colors.primary, "#1E293B"]}
        style={styles.header}
      >
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.greet}>{greeting},</Text>
              <Text style={styles.name}>{supervisor.name}</Text>
              <View style={styles.codeRow}>
                <Ionicons
                  name="shield-checkmark"
                  size={12}
                  color={colors.brandSoft}
                />
                <Text style={styles.code}>{supervisor.code} · Supervisor</Text>
              </View>
            </View>
            <Pressable
              testID="dashboard-notification-button"
              style={styles.bell}
              onPress={() => router.push("/(tabs)/notifications")}
            >
              <Ionicons
                name="notifications-outline"
                size={20}
                color={colors.white}
              />
              <View style={styles.bellDot} />
            </Pressable>
            <Pressable
              testID="dashboard-avatar"
              style={styles.avatarWrap}
              onPress={() => router.push("/(tabs)/profile")}
            >
              <Image
                source={{ uri: supervisor.photo }}
                style={styles.avatar}
              />
            </Pressable>
          </View>

          <View style={styles.statCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.statTitle}>Today&apos;s Attendance</Text>
              <Text style={styles.statValue}>
                {presentToday}
                <Text style={styles.statTotal}>/{Math.max(totalEmployees, 1)}</Text>
              </Text>
              <Text style={styles.statSub}>Employees checked in</Text>
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${(presentToday / Math.max(totalEmployees, 1)) * 100}%` },
                  ]}
                />
              </View>
            </View>
            <Pressable
              style={styles.statCta}
              testID="dashboard-start-attendance"
              onPress={() => router.push("/(tabs)/attendance")}
            >
              <Ionicons name="scan" size={20} color={colors.white} />
              <Text style={styles.statCtaText}>Scan</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.brand}
          />
        }
      >
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
        </View>

        <View style={styles.grid}>
          {FEATURES.map((f) => (
            <Pressable
              key={f.key}
              testID={`feature-${f.key}`}
              style={({ pressed }) => [
                styles.tile,
                { transform: [{ scale: pressed ? 0.97 : 1 }] },
              ]}
              onPress={() => router.push(f.path as never)}
            >
              <View style={[styles.tileIcon, { backgroundColor: f.bg }]}>
                <Ionicons name={f.icon} size={22} color={f.fg} />
              </View>
              <Text style={styles.tileText} numberOfLines={2}>
                {f.title}
              </Text>
              {f.badge ? (
                <View style={styles.tileBadge}>
                  <View style={styles.tileBadgeDot} />
                  <Text style={styles.tileBadgeText}>{f.badge}</Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Today&apos;s Attendance</Text>
          <Pressable
            testID="dashboard-view-all-attendance"
            onPress={() => router.push("/attendance-records")}
          >
            <Text style={styles.viewAll}>View all</Text>
          </Pressable>
        </View>

        <View style={styles.list}>
          {todayAttendance.map((a) => (
            <View key={a.id} style={styles.listItem}>
              <Avatar photo={a.photo} name={a.employee_name} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.listName}>{a.employee_name}</Text>
                <Text style={styles.listCode}>
                  {a.employee_code} · {a.type}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.listTime}>{a.time}</Text>
                <View
                  style={[
                    styles.listStatus,
                    {
                      backgroundColor:
                        a.status === "On Time"
                          ? colors.successSoft
                          : colors.warningSoft,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.listStatusText,
                      {
                        color:
                          a.status === "On Time"
                            ? colors.success
                            : "#B45309",
                      },
                    ]}
                  >
                    {a.status}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View style={{ height: 16 }} />
      </ScrollView>
    </View>
  );
}

function getGreeting() {
  // Greeting anchored to IST regardless of the device's local timezone,
  // so the UX stays consistent for supervisors travelling outside India.
  const hourStr = new Date().toLocaleString("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
  const h = parseInt(hourStr, 10);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingCenter: { alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, color: colors.textMuted, fontSize: 13 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 10,
  },
  greet: { color: "#94A3B8", fontSize: 13 },
  name: {
    color: colors.white,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginTop: 2,
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  code: { color: "#CBD5E1", fontSize: 12, fontWeight: "500" },
  bell: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  bellDot: {
    position: "absolute",
    top: 10,
    right: 11,
    width: 8,
    height: 8,
    backgroundColor: colors.danger,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  avatarWrap: {
    width: 42,
    height: 42,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
    overflow: "hidden",
  },
  avatar: { width: "100%", height: "100%" },

  statCard: {
    marginTop: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  statTitle: { color: "#94A3B8", fontSize: 12, fontWeight: "600" },
  statValue: {
    color: colors.white,
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginTop: 4,
  },
  statTotal: { color: "#94A3B8", fontSize: 18, fontWeight: "600" },
  statSub: { color: "#CBD5E1", fontSize: 12, marginTop: 2 },
  progressBar: {
    height: 6,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 999,
    marginTop: 10,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.success,
    borderRadius: 999,
  },
  statCta: {
    backgroundColor: colors.brand,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
    marginLeft: 12,
    gap: 4,
  },
  statCtaText: { color: colors.white, fontSize: 12, fontWeight: "700" },

  scroll: { padding: 20, paddingBottom: 32 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  viewAll: { color: colors.brand, fontSize: 13, fontWeight: "700" },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 20,
  },
  tile: {
    width: "47.5%",
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
    minHeight: 110,
    justifyContent: "space-between",
  },
  tileIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tileText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  tileBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.successSoft,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  tileBadgeDot: {
    width: 6,
    height: 6,
    backgroundColor: colors.success,
    borderRadius: 999,
  },
  tileBadgeText: {
    color: colors.success,
    fontSize: 10,
    fontWeight: "700",
  },
  list: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  listAvatar: { width: 42, height: 42, borderRadius: 999 },
  listName: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  listCode: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  listTime: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  listStatus: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  listStatusText: { fontSize: 10, fontWeight: "700" },
});
