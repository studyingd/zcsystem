function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DEPARTMENTS = [
    {value: '', text: '--请选择部门--'},
    {value: 'FIN', text: 'FIN'},
    {value: 'HR', text: 'HR'},
    {value: 'SCM', text: 'SCM'},
    {value: 'STU', text: 'STU'},
    {value: 'GMO', text: 'GMO'},
    {value: 'COM', text: 'COM'},
    {value: 'CSG', text: 'CSG'},
    {value: 'PMD', text: 'PMD'},
    {value: 'IT', text: 'IT'},
    {value: 'SMG', text: 'SMG'},
    {value: '证券事务部', text: '证券事务部'}
];

function deptOptionsHtml(selected) {
    return DEPARTMENTS.map(o =>
        `<option value="${escapeHtml(o.value)}"${selected === o.value ? ' selected' : ''}>${escapeHtml(o.text)}</option>`
    ).join('');
}
