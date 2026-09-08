import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import { api, Employee, EmployeeStatus } from "@/src/lib/api";
import { colors, radius } from "@/src/theme/colors";

const FILTERS: ("All" | EmployeeStatus)[] = [
  "All",
  "Active",
  "Inactive",
  "No Allocation",
];

const STATUS_COLOR: Record<EmployeeStatus, { bg: string; fg: string }> = {
  Active: { bg: colors.successSoft, fg: colors.success },
  Inactive: { bg: colors.dangerSoft, fg: colors.danger },
  "No Allocation": { bg: colors.warningSoft, fg: "#B45309" },
};

export default function EmployeesList() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [items, setItems] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listEmployees();
      setItems(data);
    } catch (e) {
      console.warn("employees load failed", e);
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

  const list = useMemo(() => {
    return items.filter((e) => {
      const matchesFilter = filter === "All" || e.status === filter;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        e.name.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q);
      return matchesFilter && matchesQuery;
    });
  }, [query, filter, items]);

  const counts = useMemo(() => {
    return {
      All: items.length,
      Active: items.filter((e) => e.status === "Active").length,
      Inactive: items.filter((e) => e.status === "Inactive").length,
      "No Allocation": items.filter((e) => e.status === "No Allocation")
        .length,
    } as Record<string, number>;
  }, [items]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          testID="employees-back-button"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Employees</Text>
          <Text style={styles.subtitle}>
            {items.length} total · {counts.Active} active
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/employees/add")}
          style={styles.addBtn}
          testID="employees-add-button"
        >
          <Ionicons name="add" size={20} color={colors.white} />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          testID="employees-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or code"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={10}>
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
              testID={`filter-${f.toLowerCase().replace(/\s+/g, "-")}`}
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

      <FlatList
        data={list}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        renderItem={({ item }) => <EmpCard emp={item} />}
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
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.brand} />
              <Text style={styles.emptyText}>Loading employees…</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons
                name="people-outline"
                size={36}
                color={colors.textMuted}
              />
              <Text style={styles.emptyText}>No employees found</Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

function EmpCard({ emp }: { emp: Employee }) {
  const router = useRouter();
  const c = STATUS_COLOR[emp.status];
  const projName = emp.project_name;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      testID={`employee-card-${emp.id}`}
      onPress={() => router.push(`/employees/${emp.id}`)}
    >
      <Avatar photo={emp.photo} name={emp.name} size={52} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{emp.name}</Text>
        <View style={styles.metaRow}>
          <Ionicons
            name="id-card-outline"
            size={12}
            color={colors.textMuted}
          />
          <Text style={styles.metaText}>{emp.code}</Text>
          <View style={styles.dotSep} />
          <Text style={styles.metaText}>{emp.designation ?? "—"}</Text>
        </View>
        {projName ? (
          <View style={styles.projChip}>
            <Ionicons name="briefcase" size={10} color={colors.brand} />
            <Text style={styles.projChipText} numberOfLines={1}>
              {projName}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <View style={[styles.statusPill, { backgroundColor: c.bg }]}>
          <View style={[styles.statusDot, { backgroundColor: c.fg }]} />
          <Text style={[styles.statusText, { color: c.fg }]}>
            {emp.status}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={colors.textMuted}
          style={{ marginTop: 4 }}
        />
      </View>
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
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary },
  chipScroll: { flexGrow: 0, flexShrink: 0 },
  chipRow: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 8,
  },
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
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
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
  listContent: { padding: 20, paddingTop: 4, paddingBottom: 40 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: { width: 52, height: 52, borderRadius: 999 },
  name: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    flexWrap: "wrap",
  },
  metaText: { fontSize: 12, color: colors.textMuted, fontWeight: "500" },
  dotSep: {
    width: 3,
    height: 3,
    backgroundColor: colors.borderStrong,
    borderRadius: 999,
    marginHorizontal: 4,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusDot: { width: 6, height: 6, borderRadius: 999 },
  statusText: { fontSize: 10, fontWeight: "700" },
  projChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.brandSoft,
    borderRadius: 999,
    alignSelf: "flex-start",
    maxWidth: 200,
  },
  projChipText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.brand,
  },
  empty: { alignItems: "center", paddingVertical: 60 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 12 },
});
