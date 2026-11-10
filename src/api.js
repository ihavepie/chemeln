/** 后端接口：路径和参数跟 v1 完全一致。 */

async function request(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof FormData) init.body = body;
    else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('无法连接到记录本服务，确认终端窗口还开着');
  }
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  bootstrap: (project = '') =>
    request(`/api/bootstrap${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  // 返回整个响应：课题里改标题会顺带改名，前端要拿 renamedTo 切过去
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  /* 本地 OCR：读图上的手写字（服务端调系统 Vision，不联网） */
  ocrPhoto: (body) => request('/api/ocr', { method: 'POST', body }),

  /* 结构信息查询：服务端去问 PubChem（带本地缓存），smiles / inchikey / q 三选一 */
  lookup: ({ smiles, inchikey, q } = {}) => {
    const p = new URLSearchParams();
    if (smiles) p.set('smiles', smiles);
    else if (inchikey) p.set('inchikey', inchikey);
    else if (q) p.set('q', q);
    return request(`/api/lookup?${p.toString()}`);
  },

  /* 本机 → 服务器 单向同步（只有主库那台有这个接口） */
  syncServer: () => request('/api/sync/server', { method: 'POST' }),

  /* 自己生成 PDF：返回二进制，不走 JSON */
  printPdf: async (body) => {
    const res = await fetch('/api/print/pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = '生成 PDF 失败';
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* 保持默认提示 */
      }
      throw new Error(msg);
    }
    return res.blob();
  },

  /* 课题：清单跟着 bootstrap 走，这里只管新建和删空课题 */
  projects: () => request('/api/projects').then((d) => d.items || []),
  createProject: (body) => request('/api/projects', { method: 'POST', body }).then((d) => d.items || []),
  renameProject: (name, newName) =>
    request(`/api/projects/${encodeURIComponent(name)}`, { method: 'PUT', body: { name: newName } }).then((d) => d.items || []),
  deleteProject: (name) =>
    request(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((d) => d.items || []),

  /** 列表带总数：items 可能被服务端的 LIMIT 截断，total 是「符合筛选的全部条数」 */
  experimentsPage: (query = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    return request(`/api/experiments?${p}`).then((d) => ({
      items: d.items || [],
      total: d.total ?? (d.items || []).length,
    }));
  },
  experiments: (query = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    return request(`/api/experiments?${p}`).then((d) => d.items || []);
  },
  experiment: (id) => request(`/api/experiments/${id}`).then((d) => d.experiment),
  createExperiment: (body) => request('/api/experiments', { method: 'POST', body }).then((d) => d.experiment),
  saveExperiment: (id, body) => request(`/api/experiments/${id}`, { method: 'PUT', body }).then((d) => d.experiment),
  deleteExperiment: (id) => request(`/api/experiments/${id}`, { method: 'DELETE' }),
  lock: (id, locked) => request(`/api/experiments/${id}/lock`, { method: 'POST', body: { locked } }).then((d) => d.experiment),
  duplicate: (id) => request(`/api/experiments/${id}/duplicate`, { method: 'POST' }).then((d) => d.experiment),
  /* 平行实验：同一条实验再做一次 / 只换一个变量，进同一个平行组 */
  parallel: (id) => request(`/api/experiments/${id}/parallel`, { method: 'POST', body: {} }).then((d) => d.experiment),
  moveExperiment: (id, body) => request(`/api/experiments/${id}/move`, { method: 'POST', body }).then((d) => d.experiment),

  upload: (id, formData) => request(`/api/experiments/${id}/attachments`, { method: 'POST', body: formData }),
  uploadPath: (id, body) => request(`/api/experiments/${id}/attachments/path`, { method: 'POST', body }),
  updateAttachment: (id, body) => request(`/api/attachments/${id}`, { method: 'PUT', body }),
  deleteAttachment: (id) => request(`/api/attachments/${id}`, { method: 'DELETE' }),

  categories: (query = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    return request(`/api/categories?${p}`).then((d) => d.items || []);
  },
  createCategory: (body) => request('/api/categories', { method: 'POST', body }).then((d) => d.items || []),
  saveCategory: (id, body) => request(`/api/categories/${id}`, { method: 'PUT', body }).then((d) => d.items || []),
  deleteCategory: (id) => request(`/api/categories/${id}`, { method: 'DELETE' }).then((d) => d.items || []),

  compoundsPage: (query = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    return request(`/api/compounds?${p}`).then((d) => ({
      items: d.items || [],
      total: d.total ?? (d.items || []).length,
    }));
  },
  compounds: (query = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    return request(`/api/compounds?${p}`).then((d) => d.items || []);
  },
  compound: (id) => request(`/api/compounds/${id}`).then((d) => d.compound),
  createCompound: (body) => request('/api/compounds', { method: 'POST', body }).then((d) => d.compound),
  saveCompound: (id, body) => request(`/api/compounds/${id}`, { method: 'PUT', body }).then((d) => d.compound),
  deleteCompound: (id) => request(`/api/compounds/${id}`, { method: 'DELETE' }),
  moveCompound: (id, body) => request(`/api/compounds/${id}/move`, { method: 'POST', body }).then((d) => d.compound),
  compoundFromExperiment: (expId) =>
    request('/api/compounds/from-experiment', { method: 'POST', body: { exp_id: expId, copy_files: true } }).then((d) => d.compound),
  uploadCompoundFile: (id, formData) => request(`/api/compounds/${id}/files`, { method: 'POST', body: formData }),
  uploadCompoundPath: (id, body) => request(`/api/compounds/${id}/files/path`, { method: 'POST', body }),
  updateCompoundFile: (id, body) => request(`/api/compound-files/${id}`, { method: 'PUT', body }),
  deleteCompoundFile: (id) => request(`/api/compound-files/${id}`, { method: 'DELETE' }),

  /* 改动历史（实验和化合物共用） */
  history: (entity, id) => request(`/api/history/${entity}/${id}`).then((d) => d.items || []),

  /* 回收站 */
  trash: () => request('/api/trash').then((d) => d.items || []),
  restoreTrash: (id) => request(`/api/trash/${id}/restore`, { method: 'POST' }),
  purgeTrash: (id) => request(`/api/trash/${id}`, { method: 'DELETE' }),
  clearTrash: () => request('/api/trash', { method: 'DELETE' }),

  adoptGroup: (ids, title = '') =>
    request('/api/groups/adopt', { method: 'POST', body: { ids, title } }),
  groups: (project = '') =>
    request(`/api/groups${project ? `?project=${encodeURIComponent(project)}` : ''}`).then((d) => d),
  /** 试剂库（用过的试剂汇总）：按名字聚合，带组分 / MW / 密度 / 1 mmol 折算量 */
  reagents: (project = '', q = '') => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (q) qs.set('q', q);
    const tail = qs.toString();
    return request(`/api/reagents${tail ? `?${tail}` : ''}`).then((d) => d.items || []);
  },
  screenings: (project = '') =>
    request(`/api/screenings${project ? `?project=${encodeURIComponent(project)}` : ''}`).then((d) => d.items || []),
  // 注意返回的是整个响应：{ screening, rows }——rows 里已经把每条实验的内容解析好了
  screening: (id) => request(`/api/screenings/${id}`),
  createScreening: (body) => request('/api/screenings', { method: 'POST', body }).then((d) => d.screening),
  saveScreening: (id, body) => request(`/api/screenings/${id}`, { method: 'PUT', body }).then((d) => d.screening),
  deleteScreening: (id) => request(`/api/screenings/${id}`, { method: 'DELETE' }),
};
