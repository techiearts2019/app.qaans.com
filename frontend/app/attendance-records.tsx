import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Avatar } from "@/src/components/Avatar";
import { api, AttendanceEntry, Employee } from "@/src/lib/api";
import { todayIstLabel } from "@/src/utils/time";
import { colors, radius } from "@/src/theme/colors";

const DAYS = ["Today", "Yesterday", "This Week", "This Month"];

const STATUS_COLOR = {
  "On Time": { bg: colors.successSoft, fg: colors.success },
  Late: { bg: colors.warningSoft, fg: "#B45309" },
  "Early Out": { bg: colors.infoSoft, fg: colors.info },
};

export default function AttendanceRecords() {
  const router = useRouter();
  const [activeDay, setActiveDay] = useState("Today");
  const [query, setQuery] = useState("");
  const [todayAttendance, setTodayAttendance] = useState<AttendanceEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [att, emps] = await Promise.all([
        api.todayAttendance(),
        api.listEmployees(),
      ]);
      setTodayAttendance(att);
      setEmployees(emps);
    } catch (e) {
      console.warn("records load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const present = todayAttendance.length;
  const absent = employees.length - present;
  const late = todayAttendance.filter((a) => a.status === "Late").length;

  const q = query.trim().toLowerCase();
  const filteredAttendance = useMemo(
    () =>
      todayAttendance.filter(
        (a) =>
          !q ||
          a.employee_name.toLowerCase().includes(q) ||
          a.employee_code.toLowerCase().includes(q)
      ),
    [q, todayAttendance]
  );
  const filteredAbsent = useMemo(
    () =>
      employees.filter(
        (e) =>
          !todayAttendance.find((a) => a.employee_id === e.id) &&
          e.status === "Active" &&
          (!q ||
            e.name.toLowerCase().includes(q) ||
            e.code.toLowerCase().includes(q))
      ),
    [q, employees, todayAttendance]
  );
  const noResults =
    q && filteredAttendance.length === 0 && filteredAbsent.length === 0;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          testID="records-back-button"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Attendance Records</Text>
          <Text style={styles.subtitle}>{todayIstLabel()}</Text>
        </View>
        <Pressable
          style={styles.iconBtn}
          testID="records-filter-button"
        >
          <Ionicons
            name="options-outline"
            size={20}
            color={colors.textPrimary}
          />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          testID="records-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search employee by name or code"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={10}
            testID="records-search-clear"
          >
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
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
        <View style={styles.statsRow}>
          <StatCard
            label="Present"
            value={`${present}`}
            icon="checkmark-circle"
            color={colors.success}
            bg={colors.successSoft}
          />
          <StatCard
            label="Absent"
            value={`${absent}`}
            icon="close-circle"
            color={colors.danger}
            bg={colors.dangerSoft}
          />
          <StatCard
            label="Late"
            value={`${late}`}
            icon="alarm"
            color="#B45309"
            bg={colors.warningSoft}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {DAYS.map((d) => {
            const active = d === activeDay;
            return (
              <Pressable
                key={d}
                onPress={() => setActiveDay(d)}
                testID={`record-day-${d.toLowerCase().replace(/\s+/g, "-")}`}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text
                  style={[styles.chipText, active && { color: colors.white }]}
                >
                  {d}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.listWrap}>
          <Text style={styles.sectionTitle}>Records</Text>
          {filteredAttendance.map((a) => {
            const c =
              STATUS_COLOR[a.status as keyof typeof STATUS_COLOR] ||
              STATUS_COLOR["On Time"];
            return (
              <View key={a.id} style={styles.row}>
                <Avatar photo={a.photo} name={a.employee_name} size={44} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{a.employee_name}</Text>
                  <Text style={styles.code}>{a.employee_code}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <View style={styles.timeRow}>
                    <Ionicons
                      name={
                        a.type === "Check-in"
                          ? "log-in-outline"
                          : "log-out-outline"
                      }
                      size={12}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.time}>{a.time}</Text>
                  </View>
                  <View
                    style={[styles.statusPill, { backgroundColor: c.bg }]}
                  >
                    <Text style={[styles.statusText, { color: c.fg }]}>
                      {a.status}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
          {filteredAbsent.map((e) => (
            <View key={e.id} style={styles.row}>
              <Avatar photo={e.photo} name={e.name} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{e.name}</Text>
                <Text style={styles.code}>{e.code}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: colors.dangerSoft }]}>
                <Text style={[styles.statusText, { color: colors.danger }]}>
                  Absent
                </Text>
              </View>
            </View>
          ))}
          {noResults ? (
            <View style={styles.empty}>
              <Ionicons
                name="search-outline"
                size={36}
                color={colors.textMuted}
              />
              <Text style={styles.emptyText}>No employees found</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
  bg,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
}) {
  return (
    <View style={[styles.statCard, { backgroundColor: bg }]}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
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

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary },

  empty: { alignItems: "center", paddingVertical: 40 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 12 },

  statsRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 20,
    marginTop: 8,
  },
  statCard: {
    flex: 1,
    borderRadius: radius.xl,
    padding: 14,
    alignItems: "flex-start",
  },
  statValue: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginTop: 6,
  },
  statLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
    textTransform: "uppercase",
    marginTop: 2,
    letterSpacing: 0.4,
  },

  chipRow: { paddingHorizontal: 20, paddingVertical: 18, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    flexShrink: 0,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },

  listWrap: { paddingHorizontal: 20 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.textPrimary,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 8,
  },
  avatar: { width: 44, height: 44, borderRadius: 999 },
  name: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
  code: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  time: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusText: { fontSize: 10, fontWeight: "700" },
});
