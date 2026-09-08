import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import EmployeeForm, {
  EmployeeFormState,
  emptyEmployeeForm,
} from "@/src/components/EmployeeForm";
import { api, Employee } from "@/src/lib/api";
import { colors } from "@/src/theme/colors";

/**
 * Edit Employee route. Uses the SAME `EmployeeForm` component as Add
 * Employee — identical wizard, identical fields, identical camera flow.
 * The only difference is that the form is pre-populated from
 * `GET /api/employees/{id}` and the submit hits PATCH.
 */

// Convert the API's `Employee` (backend column shape) into the wizard's
// `EmployeeFormState` (form input shape).
function toFormState(
  emp: Employee,
  projectNameById: Map<string, string>
): EmployeeFormState {
  return {
    ...emptyEmployeeForm,
    photo: emp.photo ?? undefined,
    empCode: emp.code ?? "",
    designation: emp.designation ?? undefined,
    skill: emp.skill ?? undefined,
    project: emp.project_id
      ? projectNameById.get(emp.project_id) ?? undefined
      : emp.status === "No Allocation"
      ? "No Allocation"
      : undefined,
    name: emp.name ?? "",
    gender: emp.gender ?? undefined,
    marital: emp.marital_status ?? undefined,
    dob: emp.dob ?? undefined,
    fatherName: emp.father_name ?? "",
    nominee: emp.nominee ?? "",
    primaryMobile: emp.primary_mobile ?? "",
    altMobile: emp.alt_mobile ?? "",
    email: emp.email ?? "",
    doj: emp.date_of_joining ?? undefined,
    doe: emp.date_of_exit ?? undefined,
    currentAddr: emp.current_address ?? "",
    permanentAddr: emp.permanent_address ?? "",
    aadhaar: emp.aadhaar ?? "",
    pan: emp.pan ?? "",
    uan: emp.uan ?? "",
    esi: emp.esi ?? "",
  };
}

export default function EditEmployee() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [initialForm, setInitialForm] = useState<EmployeeFormState | null>(
    null
  );
  const [loading, setLoading] = useState(true);

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
        const nameById = new Map(projs.map((p) => [p.id, p.name]));
        setInitialForm(toFormState(emp, nameById));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onDelete = () => {
    if (!id) return;
    Alert.alert(
      "Delete employee?",
      "This will permanently remove the employee and their attendance & salary history.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteEmployee(id);
              router.replace("/employees");
            } catch {
              // best-effort silent; toast belongs to inner form
            }
          },
        },
      ]
    );
  };

  if (loading || !initialForm) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background }}
        edges={["top"]}
      >
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <EmployeeForm
      title="Edit Employee"
      submitLabel="Save Changes"
      successMessage={(name) => `${name} updated`}
      initialForm={initialForm}
      photoIsPristine
      onDelete={onDelete}
      onSubmit={async ({ form, photo, projectId }) => {
        if (!id) return;
        await api.updateEmployee(id, {
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
          status: projectId ? "Active" : "No Allocation",
          ...photo,
          project_id: projectId ?? "",
        });
      }}
    />
  );
}
