import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  orderBy,
  runTransaction,
  writeBatch,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAWSqCk8rgoOPyjBNqbcRes0ecIBfrtw-0",
  authDomain: "barpos-6f462.firebaseapp.com",
  projectId: "barpos-6f462",
  storageBucket: "barpos-6f462.firebasestorage.app",
  messagingSenderId: "759647712938",
  appId: "1:759647712938:web:6b4864727a2b99944202d3",
  measurementId: "G-0FPWBY87ZL"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const CATEGORIES = ['Liquor', 'Food', 'Cigarettes'];

function peso(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateTime(d) {
  const dt = d?.toDate ? d.toDate() : new Date(d);
  return dt.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// MAIN APP
// ============================================================
export default function BarPOS() {
  const [view, setView] = useState('tables');
  const [inventory, setInventory] = useState([]);
  const [tables, setTables] = useState([]);
  const [ordersByTable, setOrdersByTable] = useState({});
  const [activeTableId, setActiveTableId] = useState(null);
  const [history, setHistory] = useState([]);
  const [toast, setToast] = useState(null);
  const [receiptData, setReceiptData] = useState(null);
  const [confirmClose, setConfirmClose] = useState(null);
  const [loading, setLoading] = useState(true);

  // ---- live inventory ----
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'inventory'), (snap) => {
      setInventory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  // ---- live tables ----
  useEffect(() => {
    const q = query(collection(db, 'tables'), orderBy('openedAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTables(list);
      setLoading(false);
      setActiveTableId(prev => {
        if (prev && list.some(t => t.id === prev)) return prev;
        return list[0]?.id || null;
      });
    });
    return unsub;
  }, []);

  // ---- live orders per table ----
  useEffect(() => {
    const unsubs = tables.map(t => {
      const q = query(collection(db, 'tables', t.id, 'orders'), orderBy('addedAt', 'asc'));
      return onSnapshot(q, (snap) => {
        setOrdersByTable(prev => ({
          ...prev,
          [t.id]: snap.docs.map(d => ({ id: d.id, ...d.data() })),
        }));
      });
    });
    return () => unsubs.forEach(u => u());
  }, [tables]);

  // ---- live transaction history ----
  useEffect(() => {
    const q = query(collection(db, 'transactions'), orderBy('paidAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  function showToast(msg, kind = 'success') {
    setToast({ msg, kind, id: Math.random() });
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 2200);
  }

  const tablesWithOrders = tables.map(t => ({ ...t, orders: ordersByTable[t.id] || [] }));
  const activeTable = tablesWithOrders.find(t => t.id === activeTableId) || null;

  async function addTable() {
    const n = tables.length + 1;
    await addDoc(collection(db, 'tables'), {
      name: `Table ${n}`,
      status: 'open',
      openedAt: Date.now(),
    });
  }

  async function addItemToTable(tableId, invItem) {
    const orders = ordersByTable[tableId] || [];
    const existing = orders.find(o => o.itemId === invItem.id);
    if (existing) {
      await updateDoc(doc(db, 'tables', tableId, 'orders', existing.id), { qty: existing.qty + 1 });
    } else {
      await addDoc(collection(db, 'tables', tableId, 'orders'), {
        itemId: invItem.id,
        name: invItem.name,
        price: invItem.price,
        category: invItem.category,
        qty: 1,
        addedAt: Date.now(),
      });
    }
  }

  async function changeQty(tableId, orderLineId, delta) {
    const orders = ordersByTable[tableId] || [];
    const line = orders.find(o => o.id === orderLineId);
    if (!line) return;
    const newQty = line.qty + delta;
    if (newQty <= 0) {
      await deleteDoc(doc(db, 'tables', tableId, 'orders', orderLineId));
    } else {
      await updateDoc(doc(db, 'tables', tableId, 'orders', orderLineId), { qty: newQty });
    }
  }

  async function removeLine(tableId, orderLineId) {
    await deleteDoc(doc(db, 'tables', tableId, 'orders', orderLineId));
  }

  function tableTotal(table) {
    return (table.orders || []).reduce((sum, o) => sum + o.price * o.qty, 0);
  }

  async function punchOrder(tableId) {
    const table = tablesWithOrders.find(t => t.id === tableId);
    if (!table || table.orders.length === 0) {
      showToast('No items to punch', 'error');
      return;
    }

    try {
      const txResult = await runTransaction(db, async (transaction) => {
        const invSnapshots = await Promise.all(
          table.orders.map(line => transaction.get(doc(db, 'inventory', line.itemId)))
        );

        for (let i = 0; i < table.orders.length; i++) {
          const line = table.orders[i];
          const invDoc = invSnapshots[i];
          if (!invDoc.exists()) throw new Error(`Item not found: ${line.name}`);
          if (invDoc.data().stock < line.qty) throw new Error(`Low stock: ${line.name}`);
        }

        table.orders.forEach((line, i) => {
          const invDoc = invSnapshots[i];
          transaction.update(doc(db, 'inventory', line.itemId), {
            stock: invDoc.data().stock - line.qty,
          });
        });

        const total = table.orders.reduce((sum, o) => sum + o.price * o.qty, 0);
        const txRef = doc(collection(db, 'transactions'));
        const txData = {
          tableName: table.name,
          items: table.orders.map(o => ({ name: o.name, price: o.price, qty: o.qty })),
          total,
          paidAt: Date.now(),
        };
        transaction.set(txRef, txData);
        table.orders.forEach(line => {
          transaction.delete(doc(db, 'tables', tableId, 'orders', line.id));
        });
        return { id: txRef.id, ...txData };
      });

      setReceiptData(txResult);
      showToast('Order punched! Ready to print');
    } catch (err) {
      showToast(err.message || 'Failed to punch order', 'error');
    }
  }

  async function closeTable(tableId) {
    const orders = ordersByTable[tableId] || [];
    const batch = writeBatch(db);
    orders.forEach(o => batch.delete(doc(db, 'tables', tableId, 'orders', o.id)));
    batch.delete(doc(db, 'tables', tableId));
    await batch.commit();
    setConfirmClose(null);
  }

  async function updateInventoryItem(id, patch) {
    await updateDoc(doc(db, 'inventory', id), patch);
  }

  async function addInventoryItem(item) {
    await addDoc(collection(db, 'inventory'), item);
  }

  async function deleteInventoryItem(id) {
    await deleteDoc(doc(db, 'inventory', id));
  }

  if (loading) {
    return (
      <div style={styles.app}>
        <div style={styles.loadingScreen}>
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <TopBar view={view} setView={setView} />

      <div style={styles.body}>
        <div style={styles.bodyInner}>
          {view === 'tables' && (
            <TablesView
              tables={tablesWithOrders}
              activeTableId={activeTableId}
              setActiveTableId={setActiveTableId}
              addTable={addTable}
              activeTable={activeTable}
              inventory={inventory}
              addItemToTable={addItemToTable}
              changeQty={changeQty}
              removeLine={removeLine}
              tableTotal={tableTotal}
              punchOrder={punchOrder}
              setConfirmClose={setConfirmClose}
            />
          )}
          {view === 'inventory' && (
            <InventoryView
              inventory={inventory}
              updateInventoryItem={updateInventoryItem}
              addInventoryItem={addInventoryItem}
              deleteInventoryItem={deleteInventoryItem}
            />
          )}
          {view === 'history' && (
            <HistoryView history={history} onReprint={(tx) => setReceiptData(tx)} />
          )}
        </div>
      </div>

      {receiptData && (
        <ReceiptModal tx={receiptData} onClose={() => setReceiptData(null)} />
      )}

      {confirmClose && (
        <ConfirmModal
          title="Close table?"
          message={`Close ${confirmClose.name}? Any pending orders will be cleared.`}
          onConfirm={() => closeTable(confirmClose.id)}
          onCancel={() => setConfirmClose(null)}
        />
      )}

      {toast && <Toast msg={toast.msg} kind={toast.kind} />}
    </div>
  );
}

// ============================================================
// TOP BAR / NAV
// ============================================================
function TopBar({ view, setView }) {
  const tabs = [
    { id: 'tables', label: 'Tables', icon: 'tables' },
    { id: 'inventory', label: 'Inventory', icon: 'package' },
    { id: 'history', label: 'History', icon: 'history' },
  ];
  return (
    <div style={styles.topbar}>
      <div style={styles.topbarInner}>
        <div style={styles.brand}>
          <span style={styles.brandMark}>L</span>
          <span style={styles.brandText}>Leeyam POS</span>
        </div>
        <div style={styles.navRow}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              style={{ ...styles.navBtn, ...(view === t.id ? styles.navBtnActive : {}) }}
            >
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TABLES VIEW
// ============================================================
function TablesView({ tables, activeTableId, setActiveTableId, addTable, activeTable, inventory, addItemToTable, changeQty, removeLine, tableTotal, punchOrder, setConfirmClose }) {
  const [category, setCategory] = useState('Liquor');

  return (
    <div style={styles.tablesLayout}>
      <div style={styles.tableTabsRow}>
        <div style={styles.tableTabsScroll}>
          {tables.map(t => {
            const isActive = t.id === activeTableId;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTableId(t.id)}
                style={{ ...styles.tableTab, ...(isActive ? styles.tableTabActive : {}) }}
              >
                <span style={styles.tableTabName}>{t.name}</span>
                {t.orders.length > 0 && (
                  <span style={{ ...styles.tableTabBadge, ...(isActive ? styles.tableTabBadgeActive : {}) }}>
                    {t.orders.reduce((s, o) => s + o.qty, 0)}
                  </span>
                )}
              </button>
            );
          })}
          <button onClick={addTable} style={styles.addTableBtn} aria-label="Add table">
            <Icon name="plus" size={18} />
          </button>
        </div>
      </div>

      {!activeTable ? (
        <EmptyState
          title="No tables"
          message="Add a table to start taking orders."
          actionLabel="Add Table"
          onAction={addTable}
        />
      ) : (
        <div style={styles.tableContent}>
          <div style={styles.tableHeaderRow}>
            <h2 style={styles.tableHeaderTitle}>{activeTable.name}</h2>
            <button onClick={() => setConfirmClose(activeTable)} style={styles.closeTableBtn}>
              <Icon name="x" size={14} />
              <span>Close</span>
            </button>
          </div>

          <div style={styles.catRow}>
            {CATEGORIES.map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                style={{ ...styles.catBtn, ...(category === c ? styles.catBtnActive : {}) }}
              >
                {c}
              </button>
            ))}
          </div>

          <div style={styles.itemGrid}>
            {inventory.filter(i => i.category === category).length === 0 ? (
              <p style={styles.noItemsHint}>No items in this category. Add from Inventory.</p>
            ) : inventory.filter(i => i.category === category).map(item => {
              const outOfStock = item.stock <= 0;
              return (
                <button
                  key={item.id}
                  disabled={outOfStock}
                  onClick={() => addItemToTable(activeTable.id, item)}
                  style={{ ...styles.itemCard, ...(outOfStock ? styles.itemCardDisabled : {}) }}
                >
                  <span style={styles.itemCardName}>{item.name}</span>
                  <span style={styles.itemCardPrice}>{peso(item.price)}</span>
                  <span style={{ ...styles.itemCardStock, ...(item.stock <= item.lowStockAt ? styles.itemCardStockLow : {}) }}>
                    {outOfStock ? 'Out of stock' : `${item.stock} left`}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={styles.orderPanel}>
            <div style={styles.orderPanelHeader}>
              <Icon name="receipt" size={16} />
              <span>Current Order</span>
            </div>

            {activeTable.orders.length === 0 ? (
              <p style={styles.orderEmptyText}>No items yet. Tap an item above to add.</p>
            ) : (
              <div style={styles.orderLines}>
                {activeTable.orders.map(line => (
                  <div key={line.id} style={styles.orderLine}>
                    <div style={styles.orderLineInfo}>
                      <span style={styles.orderLineName}>{line.name}</span>
                      <span style={styles.orderLineSub}>{peso(line.price)} × {line.qty} = {peso(line.price * line.qty)}</span>
                    </div>
                    <div style={styles.qtyControls}>
                      <button onClick={() => changeQty(activeTable.id, line.id, -1)} style={styles.qtyBtn} aria-label="Decrease">
                        <Icon name="minus" size={14} />
                      </button>
                      <span style={styles.qtyValue}>{line.qty}</span>
                      <button onClick={() => changeQty(activeTable.id, line.id, 1)} style={styles.qtyBtn} aria-label="Increase">
                        <Icon name="plus" size={14} />
                      </button>
                      <button onClick={() => removeLine(activeTable.id, line.id)} style={styles.removeBtn} aria-label="Remove">
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={styles.orderTotalRow}>
              <span>Total</span>
              <span style={styles.orderTotalValue}>{peso(tableTotal(activeTable))}</span>
            </div>

            <button
              onClick={() => punchOrder(activeTable.id)}
              disabled={activeTable.orders.length === 0}
              style={{ ...styles.punchBtn, ...(activeTable.orders.length === 0 ? styles.punchBtnDisabled : {}) }}
            >
              <Icon name="bolt" size={16} />
              <span>Punch Order</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// INVENTORY VIEW
// ============================================================
function InventoryView({ inventory, updateInventoryItem, addInventoryItem, deleteInventoryItem }) {
  const [category, setCategory] = useState('Liquor');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', price: '', stock: '', lowStockAt: '' });

  const filtered = inventory.filter(i => i.category === category);
  const lowStockCount = inventory.filter(i => i.stock <= i.lowStockAt).length;

  async function submitForm(e) {
    e.preventDefault();
    if (!form.name.trim() || form.price === '' || form.stock === '') return;
    await addInventoryItem({
      name: form.name.trim(),
      category,
      price: Number(form.price),
      stock: Number(form.stock),
      lowStockAt: Number(form.lowStockAt || 5),
    });
    setForm({ name: '', price: '', stock: '', lowStockAt: '' });
    setShowForm(false);
  }

  return (
    <div style={styles.invLayout}>
      <div style={styles.metricRow}>
        <div style={styles.metricCard}>
          <span style={styles.metricLabel}>Total Items</span>
          <span style={styles.metricValue}>{inventory.length}</span>
        </div>
        <div style={styles.metricCard}>
          <span style={styles.metricLabel}>Low Stock</span>
          <span style={{ ...styles.metricValue, color: lowStockCount > 0 ? '#dc2626' : undefined }}>{lowStockCount}</span>
        </div>
      </div>

      <div style={styles.catRow}>
        {CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            style={{ ...styles.catBtn, ...(category === c ? styles.catBtnActive : {}) }}
          >
            {c}
          </button>
        ))}
      </div>

      <div style={styles.invList}>
        {filtered.length === 0 ? (
          <EmptyState title="No items" message={`No ${category.toLowerCase()} in inventory yet.`} />
        ) : filtered.map(item => (
          <InventoryRow
            key={item.id}
            item={item}
            onUpdate={(patch) => updateInventoryItem(item.id, patch)}
            onDelete={() => deleteInventoryItem(item.id)}
          />
        ))}
      </div>

      {showForm ? (
        <form onSubmit={submitForm} style={styles.addForm}>
          <input
            placeholder="Item name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            style={styles.formInput}
            autoFocus
          />
          <div style={styles.formRow}>
            <input
              placeholder="Price"
              type="number"
              value={form.price}
              onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
              style={styles.formInputHalf}
            />
            <input
              placeholder="Stock"
              type="number"
              value={form.stock}
              onChange={e => setForm(f => ({ ...f, stock: e.target.value }))}
              style={styles.formInputHalf}
            />
          </div>
          <input
            placeholder="Low stock alert at (default 5)"
            type="number"
            value={form.lowStockAt}
            onChange={e => setForm(f => ({ ...f, lowStockAt: e.target.value }))}
            style={styles.formInput}
          />
          <div style={styles.formRow}>
            <button type="button" onClick={() => setShowForm(false)} style={styles.formCancelBtn}>Cancel</button>
            <button type="submit" style={styles.formSubmitBtn}>Add to {category}</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setShowForm(true)} style={styles.addItemBtn}>
          <Icon name="plus" size={16} />
          <span>Add {category}</span>
        </button>
      )}
    </div>
  );
}

function InventoryRow({ item, onUpdate, onDelete }) {
  const [editingStock, setEditingStock] = useState(false);
  const [stockVal, setStockVal] = useState(item.stock);
  const low = item.stock <= item.lowStockAt;

  async function saveStock() {
    await onUpdate({ stock: Math.max(0, Number(stockVal) || 0) });
    setEditingStock(false);
  }

  return (
    <div style={styles.invRow}>
      <div style={styles.invRowMain}>
        <span style={styles.invRowName}>{item.name}</span>
        <span style={styles.invRowPrice}>{peso(item.price)}</span>
      </div>
      <div style={styles.invRowActions}>
        {editingStock ? (
          <input
            type="number"
            value={stockVal}
            onChange={e => setStockVal(e.target.value)}
            onBlur={saveStock}
            onKeyDown={e => e.key === 'Enter' && saveStock()}
            style={styles.stockInput}
            autoFocus
          />
        ) : (
          <button
            onClick={() => { setStockVal(item.stock); setEditingStock(true); }}
            style={{ ...styles.stockPill, ...(low ? styles.stockPillLow : {}) }}
          >
            {item.stock} in stock
          </button>
        )}
        <button onClick={onDelete} style={styles.deleteBtn} aria-label={`Delete ${item.name}`}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// HISTORY VIEW
// ============================================================
function HistoryView({ history, onReprint }) {
  const todayTotal = useMemo(() => {
    const today = new Date().toDateString();
    return history
      .filter(tx => new Date(tx.paidAt).toDateString() === today)
      .reduce((sum, tx) => sum + tx.total, 0);
  }, [history]);

  return (
    <div style={styles.historyLayout}>
      <div style={styles.metricRow}>
        <div style={styles.metricCard}>
          <span style={styles.metricLabel}>Today's Sales</span>
          <span style={styles.metricValue}>{peso(todayTotal)}</span>
        </div>
        <div style={styles.metricCard}>
          <span style={styles.metricLabel}>Transactions</span>
          <span style={styles.metricValue}>{history.length}</span>
        </div>
      </div>

      {history.length === 0 ? (
        <EmptyState title="No history yet" message="Punched orders will appear here." />
      ) : (
        <div style={styles.historyList}>
          {history.map(tx => (
            <div key={tx.id} style={styles.historyRow}>
              <div style={styles.historyRowMain}>
                <span style={styles.historyRowTable}>{tx.tableName}</span>
                <span style={styles.historyRowDate}>{formatDateTime(tx.paidAt)}</span>
              </div>
              <div style={styles.historyRowRight}>
                <span style={styles.historyRowTotal}>{peso(tx.total)}</span>
                <button onClick={() => onReprint(tx)} style={styles.reprintBtn} aria-label="Reprint">
                  <Icon name="printer" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RECEIPT MODAL
// ============================================================
function ReceiptModal({ tx, onClose }) {
  const [width, setWidth] = useState('58');
  const printRef = useRef(null);

  function handlePrint() {
    const node = printRef.current;
    if (!node) return;
    const printWindow = window.open('', '_blank', 'width=400,height=600');
    if (!printWindow) return;
    const widthMm = width === '58' ? 58 : 80;
    printWindow.document.write(`<!DOCTYPE html><html><head><title>Receipt</title><style>
      @page { size: ${widthMm}mm auto; margin: 0; }
      * { box-sizing: border-box; }
      body { width: ${widthMm}mm; margin: 0; padding: 2mm 3mm; font-family: 'Courier New', monospace; font-size: ${widthMm === 58 ? '10px' : '12px'}; color: #000; }
      h1 { font-size: ${widthMm === 58 ? '13px' : '15px'}; margin: 0 0 2px; }
      p { margin: 1px 0; }
    </style></head><body>${node.innerHTML}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 250);
  }

  return (
    <div style={styles.modalOverlay}>
      <div style={styles.modalCard}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Receipt</h3>
          <button onClick={onClose} style={styles.modalCloseBtn} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div style={styles.printSizeRow}>
          <button onClick={() => setWidth('58')} style={{ ...styles.sizeBtn, ...(width === '58' ? styles.sizeBtnActive : {}) }}>58mm</button>
          <button onClick={() => setWidth('80')} style={{ ...styles.sizeBtn, ...(width === '80' ? styles.sizeBtnActive : {}) }}>80mm</button>
        </div>

        <div style={styles.receiptPreviewWrap}>
          <div ref={printRef} style={{ ...styles.receiptPreview, width: width === '58' ? '200px' : '260px' }}>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ margin: '0 0 2px', fontSize: width === '58' ? '13px' : '15px' }}>Leeyam Bar</h1>
              <p style={{ margin: '1px 0' }}>{tx.tableName}</p>
              <p style={{ margin: '1px 0' }}>{formatDateTime(tx.paidAt)}</p>
            </div>
            <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />
            {tx.items.map((it, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, margin: '2px 0' }}>
                <span style={{ flex: 1 }}>{it.name} x{it.qty}</span>
                <span>{peso(it.price * it.qty)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
              <span>Total</span>
              <span>{peso(tx.total)}</span>
            </div>
            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <p style={{ margin: '1px 0' }}>Thank you!</p>
            </div>
          </div>
        </div>

        <button onClick={handlePrint} style={styles.printBtn}>
          <Icon name="printer" size={16} />
          <span>Print ({width}mm)</span>
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SHARED UI
// ============================================================
function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return (
    <div style={styles.modalOverlay}>
      <div style={styles.confirmCard}>
        <h3 style={styles.modalTitle}>{title}</h3>
        <p style={styles.confirmMessage}>{message}</p>
        <div style={styles.confirmRow}>
          <button onClick={onCancel} style={styles.formCancelBtn}>Cancel</button>
          <button onClick={onConfirm} style={styles.confirmDangerBtn}>Close Table</button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, message, actionLabel, onAction }) {
  return (
    <div style={styles.emptyState}>
      <Icon name="inbox" size={28} />
      <p style={styles.emptyTitle}>{title}</p>
      <p style={styles.emptyMessage}>{message}</p>
      {actionLabel && (
        <button onClick={onAction} style={styles.emptyActionBtn}>{actionLabel}</button>
      )}
    </div>
  );
}

function Toast({ msg, kind }) {
  return (
    <div style={{ ...styles.toast, ...(kind === 'error' ? styles.toastError : {}) }}>
      <Icon name={kind === 'error' ? 'alert-circle' : 'check'} size={16} />
      <span>{msg}</span>
    </div>
  );
}

function Icon({ name, size = 16 }) {
  const paths = {
    tables: <path d="M3 4h18v4H3zM3 10h7v10H3zM12 10h9v10h-9z" />,
    package: <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8" />,
    history: <path d="M12 8v4l3 3M21 12a9 9 0 11-3-6.7M21 4v5h-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    x: <path d="M18 6L6 18M6 6l12 12" />,
    trash: <path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14" />,
    receipt: <path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z M9 7h6M9 11h6" />,
    bolt: <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />,
    printer: <path d="M6 9V2h12v7M6 18H4a1 1 0 01-1-1v-6a1 1 0 011-1h18a1 1 0 011 1v6a1 1 0 01-1 1h-2M6 14h12v8H6z" />,
    inbox: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z" />,
    'alert-circle': <path d="M12 2a10 10 0 100 20 10 10 0 000-20zM12 8v5M12 16h.01" />,
    check: <path d="M20 6L9 17l-5-5" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || null}
    </svg>
  );
}

// ============================================================
// STYLES — clean dark-accent palette, strong contrast
// ============================================================
const C = {
  // Brand
  primary: '#1a1a2e',       // deep navy
  primaryHover: '#16213e',
  accent: '#e94560',        // vivid red-pink for CTAs
  accentLight: '#fde8ec',
  // Surfaces
  bg: '#f8f8f8',            // near-white page bg
  surface: '#ffffff',       // cards
  surfaceAlt: '#f0f0f0',   // metric cards, subtle areas
  // Text
  textPrimary: '#111111',
  textSecondary: '#555555',
  textMuted: '#888888',
  // Borders
  border: '#e0e0e0',
  borderStrong: '#cccccc',
  // Status
  success: '#16a34a',
  danger: '#dc2626',
  dangerLight: '#fef2f2',
  warning: '#d97706',
  warningLight: '#fffbeb',
};

const styles = {
  app: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    background: C.bg,
    minHeight: '100vh',
    color: C.textPrimary,
    width: '100%',
    paddingBottom: 32,
  },
  loadingScreen: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100vh', color: C.textMuted, fontSize: 15,
  },

  // Topbar
  topbar: {
    position: 'sticky', top: 0, zIndex: 10,
    background: C.surface,
    borderBottom: `1px solid ${C.border}`,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  topbarInner: { maxWidth: 600, margin: '0 auto', padding: '12px 16px 0' },
  brand: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  brandMark: {
    width: 30, height: 30, borderRadius: 8,
    background: C.primary, color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: 12, letterSpacing: '0.5px',
  },
  brandText: { fontWeight: 700, fontSize: 17, color: C.textPrimary },
  navRow: { display: 'flex', gap: 0 },
  navBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    padding: '8px 4px', fontSize: 11, fontWeight: 500,
    color: C.textMuted,
    background: 'none', border: 'none',
    borderBottom: '2px solid transparent', cursor: 'pointer',
    transition: 'color 0.15s',
  },
  navBtnActive: { color: C.accent, borderBottom: `2px solid ${C.accent}`, fontWeight: 600 },

  body: { padding: 0 },
  bodyInner: { maxWidth: 600, margin: '0 auto', padding: 16 },

  // Tables
  tablesLayout: { display: 'flex', flexDirection: 'column', gap: 14 },
  tableTabsRow: { display: 'flex' },
  tableTabsScroll: {
    display: 'flex', gap: 8, overflowX: 'auto',
    paddingBottom: 4, WebkitOverflowScrolling: 'touch',
  },
  tableTab: {
    flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', borderRadius: 999,
    border: `1px solid ${C.border}`,
    background: C.surface, fontSize: 13, fontWeight: 500,
    color: C.textSecondary, cursor: 'pointer',
  },
  tableTabActive: {
    background: C.primary, color: '#fff',
    border: `1px solid ${C.primary}`, fontWeight: 600,
  },
  tableTabName: {},
  tableTabBadge: {
    background: C.accentLight, color: C.accent,
    fontSize: 11, borderRadius: 999, padding: '1px 6px', fontWeight: 700,
  },
  tableTabBadgeActive: { background: 'rgba(255,255,255,0.25)', color: '#fff' },
  addTableBtn: {
    flexShrink: 0, width: 36, height: 36, borderRadius: 999,
    border: `1px dashed ${C.borderStrong}`,
    background: 'transparent', display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer', color: C.textMuted,
  },

  tableContent: { display: 'flex', flexDirection: 'column', gap: 14 },
  tableHeaderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  tableHeaderTitle: { fontSize: 19, fontWeight: 700, margin: 0, color: C.textPrimary },
  closeTableBtn: {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '6px 12px',
    borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface,
    color: C.textSecondary, cursor: 'pointer', fontWeight: 500,
  },

  catRow: { display: 'flex', gap: 8 },
  catBtn: {
    flex: 1, padding: '9px 0', borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface, fontSize: 13, fontWeight: 500,
    color: C.textSecondary, cursor: 'pointer',
  },
  catBtnActive: {
    background: C.primary, color: '#fff',
    border: `1px solid ${C.primary}`, fontWeight: 700,
  },

  noItemsHint: {
    gridColumn: '1/-1', fontSize: 13, color: C.textMuted,
    textAlign: 'center', padding: '20px 0', margin: 0,
  },
  itemGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 10 },
  itemCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3,
    padding: '13px 12px', borderRadius: 12,
    border: `1px solid ${C.border}`, background: C.surface,
    cursor: 'pointer', textAlign: 'left',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    transition: 'box-shadow 0.15s',
  },
  itemCardDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  itemCardName: { fontSize: 13, fontWeight: 600, color: C.textPrimary, lineHeight: 1.3 },
  itemCardPrice: { fontSize: 15, fontWeight: 700, color: C.primary },
  itemCardStock: { fontSize: 11, fontWeight: 500, color: C.textMuted },
  itemCardStockLow: { color: C.warning },

  // Order panel
  orderPanel: {
    borderRadius: 14, border: `1px solid ${C.border}`,
    background: C.surface, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  orderPanelHeader: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 13, fontWeight: 700, color: C.textPrimary,
  },
  orderEmptyText: { fontSize: 13, color: C.textMuted, margin: 0 },
  orderLines: { display: 'flex', flexDirection: 'column', gap: 10 },
  orderLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  orderLineInfo: { display: 'flex', flexDirection: 'column' },
  orderLineName: { fontSize: 13, fontWeight: 600, color: C.textPrimary },
  orderLineSub: { fontSize: 12, color: C.textSecondary },
  qtyControls: { display: 'flex', alignItems: 'center', gap: 4 },
  qtyBtn: {
    width: 28, height: 28, borderRadius: 8,
    border: `1px solid ${C.border}`, background: C.surfaceAlt,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    color: C.textPrimary,
  },
  qtyValue: { fontSize: 13, fontWeight: 700, minWidth: 20, textAlign: 'center' },
  removeBtn: {
    width: 28, height: 28, borderRadius: 8,
    border: 'none', background: C.dangerLight, color: C.danger,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', marginLeft: 4,
  },
  orderTotalRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    fontSize: 14, fontWeight: 600,
    borderTop: `1px solid ${C.border}`, paddingTop: 12,
    color: C.textPrimary,
  },
  orderTotalValue: { fontSize: 20, fontWeight: 800, color: C.primary },
  punchBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    padding: '13px', borderRadius: 10, border: 'none',
    background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
  },
  punchBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },

  // Inventory
  invLayout: { display: 'flex', flexDirection: 'column', gap: 14 },
  metricRow: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 },
  metricCard: {
    background: C.primary, borderRadius: 12,
    padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4,
    boxShadow: '0 2px 8px rgba(26,26,46,0.15)',
  },
  metricLabel: { fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  metricValue: { fontSize: 28, fontWeight: 800, color: '#fff' },
  invList: { display: 'flex', flexDirection: 'column', gap: 8 },
  invRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 14px', borderRadius: 10,
    border: `1px solid ${C.border}`, background: C.surface,
    boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
  },
  invRowMain: { display: 'flex', flexDirection: 'column', gap: 1 },
  invRowName: { fontSize: 14, fontWeight: 600, color: C.textPrimary },
  invRowPrice: { fontSize: 12, fontWeight: 500, color: C.textSecondary },
  invRowActions: { display: 'flex', alignItems: 'center', gap: 8 },
  stockPill: {
    fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 999,
    border: `1px solid ${C.border}`, background: C.surfaceAlt,
    cursor: 'pointer', color: C.textSecondary,
  },
  stockPillLow: { background: C.warningLight, color: C.warning, border: `1px solid #fcd34d` },
  stockInput: { width: 64, height: 32, fontSize: 13, textAlign: 'center', borderRadius: 6, border: `1px solid ${C.border}` },
  deleteBtn: {
    width: 30, height: 30, borderRadius: 8, border: 'none',
    background: C.dangerLight, color: C.danger,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  },
  addItemBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    padding: '12px', borderRadius: 10,
    border: `1.5px dashed ${C.borderStrong}`, background: 'transparent',
    color: C.textSecondary, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  },
  addForm: {
    display: 'flex', flexDirection: 'column', gap: 9, padding: 14,
    borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  formInput: { width: '100%', padding: '9px 10px', borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 13 },
  formInputHalf: { width: '100%', padding: '9px 10px', borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 13 },
  formRow: { display: 'flex', gap: 8 },
  formCancelBtn: {
    flex: 1, padding: '10px', borderRadius: 8,
    border: `1px solid ${C.border}`, background: C.surfaceAlt,
    cursor: 'pointer', fontSize: 13, fontWeight: 500, color: C.textSecondary,
  },
  formSubmitBtn: {
    flex: 1, padding: '10px', borderRadius: 8,
    border: 'none', background: C.primary, color: '#fff',
    cursor: 'pointer', fontSize: 13, fontWeight: 700,
  },

  // History
  historyLayout: { display: 'flex', flexDirection: 'column', gap: 14 },
  historyList: { display: 'flex', flexDirection: 'column', gap: 8 },
  historyRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 14px', borderRadius: 10,
    border: `1px solid ${C.border}`, background: C.surface,
  },
  historyRowMain: { display: 'flex', flexDirection: 'column', gap: 2 },
  historyRowTable: { fontSize: 13, fontWeight: 600, color: C.textPrimary },
  historyRowDate: { fontSize: 12, color: C.textMuted },
  historyRowRight: { display: 'flex', alignItems: 'center', gap: 10 },
  historyRowTotal: { fontSize: 15, fontWeight: 700, color: C.primary },
  reprintBtn: {
    width: 32, height: 32, borderRadius: 8,
    border: `1px solid ${C.border}`, background: C.surfaceAlt,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    color: C.textSecondary,
  },

  // Modals
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16,
  },
  modalCard: {
    background: C.surface, borderRadius: 16, padding: 20, width: '100%',
    maxWidth: 340, maxHeight: '90vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { fontSize: 16, fontWeight: 700, margin: 0, color: C.textPrimary },
  modalCloseBtn: {
    width: 30, height: 30, borderRadius: 8, border: 'none',
    background: C.surfaceAlt, display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer', color: C.textSecondary,
  },
  printSizeRow: { display: 'flex', gap: 8 },
  sizeBtn: {
    flex: 1, padding: '8px', borderRadius: 8,
    border: `1px solid ${C.border}`, background: C.surfaceAlt,
    cursor: 'pointer', fontSize: 13, fontWeight: 500, color: C.textSecondary,
  },
  sizeBtnActive: { background: C.primary, color: '#fff', border: `1px solid ${C.primary}`, fontWeight: 700 },
  receiptPreviewWrap: { display: 'flex', justifyContent: 'center', background: '#e8e8e8', borderRadius: 10, padding: 16 },
  receiptPreview: { background: '#fff', padding: '10px 12px', fontFamily: "'Courier New', monospace", fontSize: 11, color: '#000', boxShadow: '0 0 0 1px #ddd' },
  printBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    padding: '13px', borderRadius: 10, border: 'none',
    background: C.accent, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
  },
  confirmCard: {
    background: C.surface, borderRadius: 16, padding: 20, width: '100%', maxWidth: 320,
    display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
  },
  confirmMessage: { fontSize: 13, color: C.textSecondary, margin: 0, lineHeight: 1.5 },
  confirmRow: { display: 'flex', gap: 8, marginTop: 4 },
  confirmDangerBtn: {
    flex: 1, padding: '10px', borderRadius: 8, border: 'none',
    background: C.danger, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700,
  },

  // Empty state
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 6, padding: '40px 16px', color: C.textMuted,
  },
  emptyTitle: { fontSize: 14, fontWeight: 700, margin: 0, color: C.textSecondary },
  emptyMessage: { fontSize: 13, textAlign: 'center', margin: 0, color: C.textMuted },
  emptyActionBtn: {
    marginTop: 8, padding: '9px 18px', borderRadius: 8,
    border: 'none', background: C.primary, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },

  // Toast
  toast: {
    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
    background: '#111', color: '#fff',
    padding: '11px 18px', borderRadius: 999, fontSize: 13, fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 7, zIndex: 200,
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    whiteSpace: 'nowrap',
  },
  toastError: { background: C.danger },
};