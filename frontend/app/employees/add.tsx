import EmployeeForm from "@/src/components/EmployeeForm";
import { api } from "@/src/lib/api";

/**
 * Add Employee route. Delegates the whole multi-step form (Personal /
 * Contact / Documents + camera capture) to `EmployeeForm` so it stays
 * pixel-identical with the Edit Employee route.
 */
export default function AddEmployee() {
  return (
    <EmployeeForm
      title="Add Employee"
      submitLabel="Add Employee"
      successMessage={(name) => `${name} added successfully`}
      onSubmit={async ({ form, photo, projectId }) => {
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
          status: projectId ? "Active" : "No Allocation",
          ...photo,
          project_id: projectId,
        });
      }}
    />
  );
}
