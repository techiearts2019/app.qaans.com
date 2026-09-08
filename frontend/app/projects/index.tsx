import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  api,
  Employee,
  Project,
  ProjectStatus,
} from "@/src/lib/api";
import { colors, radius } from "@/src/theme/colors";
import { Avatar } from "@/src/components/Avatar";

const FILTERS: ("All" | ProjectStatus)[] = [
  "All",
  "Active",
  "On Hold",
  "Completed",
];

const STATUS_META: Record<ProjectStatus, { bg: string; fg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  Active: { bg: colors.successSoft, fg: colors.success, icon: "ellipse" },
  "On Hold": { bg: colors.warningSoft, fg: "#B45309", icon: "pause" },
  Completed: { bg: colors.infoSoft, fg: colors.info, icon: "checkmark" },
};

export default function ProjectsList() {
  const router = useRouter();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Project[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projs, emps] = await Promise.all([
        api.listProjects(),
        api.listEmployees(),
      ]);
      setItems(projs);
      setEmployees(emps);
    } catch (e) {
      console.warn("projects load failed", e);
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

  const counts = useMemo(() => {
    return {
      All: items.length,
      Active: items.filter((p) => p.status === "Active").length,
      "On Hold": items.filter((p) => p.status === "On Hold").length,
      Completed: items.filter((p) => p.status === "Completed").length,
    } as Record<string, number>;
  }, [items]);

  const list = useMemo(() => {
    return items.filter((p) => {
      const matchesFilter = filter === "All" || p.status === filter;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.location ?? "").toLowerCase().includes(q);
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, items]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          testID="projects-back-button"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Projects</Text>
          <Text style={styles.subtitle}>
            {items.length} projects · {counts.Active} active
          </Text>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          testID="projects-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects by name or location"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={10}
            testID="projects-search-clear"
          >
            <Ionicons
              name="close-circle"
              size={18}
              color={colors.textMuted}
            />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {FILTERS.map((f) => {
          const active = f === filter;
          return (
            <Pressable
              key={f}
              testID={`project-filter-${f.toLowerCase().replace(/\s+/g, "-")}`}
              onPress={() => setFilter(f)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text
                style={[styles.chipText, active && { color: colors.white }]}
              >
                {f}
              </Text>
              <View
                style={[
                  styles.chipCount,
                  active && { backgroundColor: "rgba(255,255,255,0.18)" },
                ]}
              >
                <Text
                  style={[
                    styles.chipCountText,
                    active && { color: colors.white },
                  ]}
                >
                  {counts[f]}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.list}
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
        {list.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            employees={employees}
            onPress={() => router.push(`/projects/${p.id}`)}
          />
        ))}

        {list.length === 0 ? (
          <View style={styles.empty}>
            {loading ? (
              <ActivityIndicator color={colors.brand} />
            ) : (
              <Ionicons
                name="briefcase-outline"
                size={36}
                color={colors.textMuted}
              />
            )}
            <Text style={styles.emptyText}>
              {loading ? "Loading projects…" : "No projects in this list"}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProjectRow({
  project,
  employees,
  onPress,
}: {
  project: Project;
  employees: Employee[];
  onPress: () => void;
}) {
  const meta = STATUS_META[project.status];
  const allocated = project.allocated_employee_ids.length;
  const stackEmps = employees.filter((e) =>
    project.allocated_employee_ids.includes(e.id)
  );

  return (
    <Pressable
      style={styles.row}
      testID={`project-card-${project.id}`}
      onPress={onPress}
    >
      <View style={[styles.iconBox, { backgroundColor: meta.bg }]}>
        <Ionicons name="briefcase" size={20} color={meta.fg} />
      </View>

      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {project.name}
          </Text>
          <View style={[styles.statusPill, { backgroundColor: meta.bg }]}>
            <View style={[styles.statusDot, { backgroundColor: meta.fg }]} />
            <Text style={[styles.statusText, { color: meta.fg }]}>
              {project.status}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <Ionicons
            name="location-outline"
            size={12}
            color={colors.textMuted}
          />
          <Text style={styles.metaText} numberOfLines={1}>
            {project.location}
          </Text>
          <View style={styles.dotSep} />
          <Ionicons
            name="calendar-outline"
            size={12}
            color={colors.textMuted}
          />
          <Text style={styles.metaText}>{project.startDate}</Text>
        </View>

        <View style={styles.footerRow}>
          <View style={styles.avatarStack}>
            {stackEmps.slice(0, 3).map((e, i) => (
              <Avatar
                key={e.id}
                photo={e.photo}
                name={e.name}
                size={28}
                style={{
                  marginLeft: i === 0 ? 0 : -8,
                  borderWidth: 2,
                  borderColor: colors.card,
                }}
              />
            ))}
            {allocated === 0 ? (
              <View style={styles.stackEmpty}>
                <Ionicons
                  name="person-outline"
                  size={11}
                  color={colors.textMuted}
                />
              </View>
            ) : null}
          </View>
          <Text style={styles.allocText}>
            {allocated === 0
              ? "No employees"
              : `${allocated} ${allocated === 1 ? "employee" : "employees"}`}
          </Text>
        </View>
      </View>

      <Ionicons
        name="chevron-forward"
        size={18}
        color={colors.textMuted}
        style={{ marginLeft: 4 }}
      />
    </Pressable>
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
    fontSize: 22,
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
    marginBottom: 8,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary },

  chipScroll: { flexGrow: 0, flexShrink: 0 },
  chipRow: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12, gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    height: 36,
    flexShrink: 0,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
  chipCount: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    minWidth: 22,
    alignItems: "center",
  },
  chipCountText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
  },

  list: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 40 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusDot: { width: 5, height: 5, borderRadius: 999 },
  statusText: { fontSize: 10, fontWeight: "700" },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    flexWrap: "wrap",
  },
  metaText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: "500",
  },
  dotSep: {
    width: 3,
    height: 3,
    backgroundColor: colors.borderStrong,
    borderRadius: 999,
    marginHorizontal: 4,
  },

  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  avatarStack: { flexDirection: "row", alignItems: "center" },
  stackAvatar: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.white,
  },
  stackEmpty: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  allocText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "600",
  },

  empty: { alignItems: "center", paddingVertical: 60 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 12 },
});
