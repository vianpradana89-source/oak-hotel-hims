import { useState, useMemo } from 'react';

export interface PosMenuItem {
  id: number;
  item_code?: string;
  name: string;
  category_name?: string;
  price: number | string;
  is_available?: boolean;
}

export interface PosOrderItem {
  id: number;
  order_number: string;
  table_number?: string;
  guest_name?: string;
  status: string;
  total_amount: number | string;
  created_at?: string;
}

interface Props {
  propertyId: number | null;
  posMenu: PosMenuItem[];
  posOrders: PosOrderItem[];
  onCreateDemoOrder: () => void | Promise<void>;
  onRefresh?: () => void;
}

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

export default function PosWorkspace({
  propertyId,
  posMenu,
  posOrders,
  onCreateDemoOrder,
  onRefresh
}: Props) {
  const [activeTab, setActiveTab] = useState<'register' | 'orders'>('register');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<{ item: PosMenuItem; qty: number }[]>([]);
  const [tableNumber, setTableNumber] = useState('Table 1');
  const [guestName, setGuestName] = useState('Walk-in Guest');

  const categories = useMemo(() => {
    const set = new Set<string>();
    posMenu.forEach((m) => {
      if (m.category_name) set.add(m.category_name);
    });
    return Array.from(set);
  }, [posMenu]);

  const filteredMenu = useMemo(() => {
    return posMenu.filter((item) => {
      const matchSearch =
        searchQuery === '' ||
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.item_code && item.item_code.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchCat = selectedCategory === 'ALL' || item.category_name === selectedCategory;
      return matchSearch && matchCat;
    });
  }, [posMenu, searchQuery, selectedCategory]);

  const addToCart = (item: PosMenuItem) => {
    setCart((prev) => {
      const idx = prev.findIndex((p) => p.item.id === item.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { item, qty: 1 }];
    });
  };

  const removeFromCart = (itemId: number) => {
    setCart((prev) => prev.filter((p) => p.item.id !== itemId));
  };

  const updateCartQty = (itemId: number, delta: number) => {
    setCart((prev) => {
      return prev
        .map((p) => {
          if (p.item.id === itemId) {
            const newQty = p.qty + delta;
            return newQty > 0 ? { ...p, qty: newQty } : null;
          }
          return p;
        })
        .filter(Boolean) as { item: PosMenuItem; qty: number }[];
    });
  };

  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, line) => sum + Number(line.item.price) * line.qty, 0);
  }, [cart]);

  const totalOrdersAmount = useMemo(() => {
    return posOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
  }, [posOrders]);

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-purple-50 text-purple-800 border border-purple-200/60 uppercase">
              Departemen Operasional POS
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Point of Sale (POS) &amp; F&amp;B</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Workspace operasional kasir restoran, pesanan meja tamu hotel, dan penjualan langsung.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="p-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors cursor-pointer"
              title="Refresh Data"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={onCreateDemoOrder}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Buat Demo Order
          </button>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Menu Aktif</div>
          <div className="text-2xl font-black text-gray-900 mt-1">{posMenu.length}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Item makanan &amp; minuman</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Total Pesanan</div>
          <div className="text-2xl font-black text-purple-700 mt-1">{posOrders.length}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Order tercatat</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Total Transaksi POS</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">{formatIDR(totalOrdersAmount)}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Akumulasi penjualan</div>
        </div>
      </div>

      {/* View Selector Tabs */}
      <div className="flex gap-2 border-b border-gray-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab('register')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'register'
              ? 'bg-purple-900 text-white shadow-xs'
              : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
          }`}
        >
          Kasir &amp; Menu POS
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('orders')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'orders'
              ? 'bg-purple-900 text-white shadow-xs'
              : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
          }`}
        >
          Riwayat Order ({posOrders.length})
        </button>
      </div>

      {activeTab === 'register' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Menu Picker (2 cols) */}
          <div className="lg:col-span-2 space-y-4">
            {/* Search & Category Filter */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs space-y-3">
              <div className="relative">
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Cari menu F&B..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:outline-hidden"
                />
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('ALL')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                    selectedCategory === 'ALL'
                      ? 'bg-purple-800 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  Semua
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      selectedCategory === cat
                        ? 'bg-purple-800 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Menu Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {filteredMenu.map((item) => (
                <div
                  key={item.id}
                  onClick={() => addToCart(item)}
                  className="bg-white border border-gray-200 hover:border-purple-300 hover:shadow-md rounded-xl p-3 flex flex-col justify-between transition-all cursor-pointer group"
                >
                  <div>
                    <span className="text-[10px] font-semibold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                      {item.category_name || 'F&B'}
                    </span>
                    <h4 className="font-bold text-xs sm:text-sm text-gray-900 mt-1.5 group-hover:text-purple-900 transition-colors">
                      {item.name}
                    </h4>
                    {item.item_code && (
                      <div className="text-[10px] text-gray-400 font-mono mt-0.5">{item.item_code}</div>
                    )}
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between">
                    <span className="font-extrabold text-xs sm:text-sm text-gray-900">
                      {formatIDR(Number(item.price))}
                    </span>
                    <button
                      type="button"
                      className="p-1 rounded-lg bg-gray-100 group-hover:bg-purple-100 text-gray-600 group-hover:text-purple-800 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Cart / Order Slip (1 col) */}
          <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col justify-between h-fit space-y-4">
            <div>
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <h3 className="font-bold text-sm text-gray-900">Slip Pesanan</h3>
                <span className="text-xs bg-purple-50 text-purple-700 font-semibold px-2 py-0.5 rounded-full">
                  {cart.reduce((c, l) => c + l.qty, 0)} Items
                </span>
              </div>

              {/* Table & Guest Form */}
              <div className="grid grid-cols-2 gap-2 my-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Nomor Meja</label>
                  <input
                    type="text"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                    className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-1.5 mt-0.5"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-gray-500">Nama Tamu</label>
                  <input
                    type="text"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-1.5 mt-0.5"
                  />
                </div>
              </div>

              {/* Cart Items */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {cart.length === 0 ? (
                  <div className="py-8 text-center text-xs text-gray-400">
                    Klik item menu di samping untuk menambahkan pesanan.
                  </div>
                ) : (
                  cart.map(({ item, qty }) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-2 bg-gray-50 rounded-lg text-xs"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="font-semibold text-gray-800 truncate">{item.name}</div>
                        <div className="text-gray-500 text-[11px]">
                          {formatIDR(Number(item.price))}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.id, -1)}
                          className="w-5 h-5 flex items-center justify-center rounded bg-gray-200 text-gray-700 font-bold hover:bg-gray-300"
                        >
                          -
                        </button>
                        <span className="font-bold w-4 text-center">{qty}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.id, 1)}
                          className="w-5 h-5 flex items-center justify-center rounded bg-gray-200 text-gray-700 font-bold hover:bg-gray-300"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromCart(item.id)}
                          className="text-red-500 hover:text-red-700 ml-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Total & Checkout */}
            <div className="border-t border-gray-100 pt-3 space-y-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Subtotal</span>
                <span>{formatIDR(cartSubtotal)}</span>
              </div>
              <div className="flex justify-between text-sm font-black text-gray-900">
                <span>Grand Total</span>
                <span>{formatIDR(cartSubtotal)}</span>
              </div>
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => {
                  alert(`Pesanan ${tableNumber} untuk ${guestName} sebesar ${formatIDR(cartSubtotal)} berhasil diproses!`);
                  setCart([]);
                }}
                className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white font-bold text-xs sm:text-sm transition-colors shadow-xs cursor-pointer"
              >
                Simpan &amp; Bayar Order
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Orders History Table */
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-gray-50/80 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="py-3 px-4">Nomor Order</th>
                  <th className="py-3 px-4">Meja</th>
                  <th className="py-3 px-4">Nama Tamu</th>
                  <th className="py-3 px-4 text-right">Total (IDR)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {posOrders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-400">
                      Belum ada order POS tercatat.
                    </td>
                  </tr>
                ) : (
                  posOrders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-purple-900">
                        {order.order_number}
                      </td>
                      <td className="py-3 px-4 text-gray-700">
                        {order.table_number || 'Takeaway'}
                      </td>
                      <td className="py-3 px-4 font-medium text-gray-900">
                        {order.guest_name || 'Walk-in Guest'}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-gray-900">
                        {formatIDR(Number(order.total_amount || 0))}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                          {order.status || 'PAID'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
