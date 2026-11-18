import { useState } from 'react';
import { departmentLabel } from './departments';
import { toBaht } from './money';

const previewRoles = ['Board', 'Finance Head'] as const;
type PreviewRole = typeof previewRoles[number];

const sampleExpenses = [
  { id: 1, date: '2026-11-17', description: 'อุปกรณ์เวิร์กช็อป', owner: 'เมย์ (ตัวอย่าง)', department: 'WORKSHOPS', totalSatang: 125000 },
  { id: 2, date: '2026-11-16', description: 'พิมพ์โปสเตอร์กิจกรรม', owner: 'นัท (ตัวอย่าง)', department: 'PR', totalSatang: 48000 },
  { id: 3, date: '2026-11-15', description: 'สาย HDMI สำหรับห้องประชุม', owner: 'ต้น (ตัวอย่าง)', department: 'IT', totalSatang: 69050 },
];

const totalSatang = sampleExpenses.reduce((total, expense) => total + expense.totalSatang, 0);

export function OrganizationPreview() {
  const [role, setRole] = useState<PreviewRole | null>(null);

  return (
    <section className="card" aria-labelledby="organization-preview-title">
      <div className="section-heading">
        <h2 id="organization-preview-title">ลองมุมมองทั้งชมรม</h2>
      </div>
      <p className="muted">เลือกบทบาทเพื่อดูบิลจำลองของสมาชิกหลายคน</p>
      <div className="department-options" role="group" aria-label="บทบาทสำหรับสาธิต">
        {previewRoles.map(previewRole => (
          <label key={previewRole}>
            <input
              type="checkbox"
              checked={role === previewRole}
              onChange={event => setRole(event.currentTarget.checked ? previewRole : null)}
            />
            <span>{previewRole}</span>
          </label>
        ))}
      </div>
      {role && (
        <>
          <div className="summary" aria-live="polite">
            <div><small>ยอดรวมจำลอง · {role}</small><strong>฿{toBaht(totalSatang)}</strong></div>
            <div><small>จำนวนบิลจำลอง</small><strong>{sampleExpenses.length}</strong></div>
          </div>
          <div className="table-scroll" role="region" aria-label="บิลจำลองทั้งชมรม" tabIndex={0}>
            <table className="expense-table preview-table">
              <thead>
                <tr>
                  <th scope="col">วันที่</th>
                  <th scope="col">รายการ</th>
                  <th scope="col">ผู้บันทึก</th>
                  <th scope="col">แผนก</th>
                  <th scope="col" className="amount">ยอดจ่าย</th>
                </tr>
              </thead>
              <tbody>
                {sampleExpenses.map(expense => (
                  <tr key={expense.id}>
                    <td className="date-cell">{expense.date}</td>
                    <td className="counterparty">{expense.description}</td>
                    <td>{expense.owner}</td>
                    <td>{departmentLabel(expense.department)}</td>
                    <td className="amount">฿{toBaht(expense.totalSatang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
