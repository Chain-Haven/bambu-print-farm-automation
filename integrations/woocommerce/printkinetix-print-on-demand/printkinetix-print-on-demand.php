<?php
/**
 * Plugin Name: PrintKinetix Print-on-Demand
 * Description: Sell 3D-printed products WooCommerce-native: attach a 3D model to any product, let customers customize color/size/strength/quality, and paid orders are automatically printed and shipped by your PrintKinetix farm.
 * Version: 1.0.0
 * Author: PrintKinetix
 * License: MIT
 * Requires Plugins: woocommerce
 * Text Domain: printkinetix-pod
 */

if (!defined('ABSPATH')) {
    exit;
}

class PrintKinetix_POD {
    const OPTION_GROUP = 'pkx_pod_settings';
    const OPT_API_BASE = 'pkx_api_base_url';
    const OPT_API_KEY  = 'pkx_api_key';
    const META_FILE_ID = '_pkx_file_id';
    const META_FILE_NAME = '_pkx_file_name';
    const META_PREVIEW_URL = '_pkx_preview_url';
    const META_MATERIALS = '_pkx_materials';
    const META_ORDER_ID = '_pkx_order_id';
    const META_ORDER_STATUS = '_pkx_order_status';

    public static function init() {
        add_action('admin_menu', [__CLASS__, 'admin_menu']);
        add_action('admin_init', [__CLASS__, 'register_settings']);
        add_action('add_meta_boxes', [__CLASS__, 'add_product_meta_box']);
        add_action('save_post_product', [__CLASS__, 'save_product_meta'], 10, 2);

        // Customer-facing customizer on product pages.
        add_action('woocommerce_before_add_to_cart_button', [__CLASS__, 'render_customizer']);
        add_action('wp_enqueue_scripts', [__CLASS__, 'enqueue_assets']);
        add_filter('woocommerce_add_cart_item_data', [__CLASS__, 'capture_cart_item_data'], 10, 2);
        add_filter('woocommerce_get_item_data', [__CLASS__, 'display_cart_item_data'], 10, 2);
        add_action('woocommerce_checkout_create_order_line_item', [__CLASS__, 'save_order_item_meta'], 10, 4);

        // Paid order -> PrintKinetix farm.
        add_action('woocommerce_order_status_processing', [__CLASS__, 'submit_order_to_farm'], 10, 1);
        add_action('woocommerce_order_status_completed', [__CLASS__, 'submit_order_to_farm'], 10, 1);

        // Status sync back into WooCommerce.
        add_action('pkx_pod_sync_orders', [__CLASS__, 'sync_farm_orders']);
        if (!wp_next_scheduled('pkx_pod_sync_orders')) {
            wp_schedule_event(time() + 300, 'hourly', 'pkx_pod_sync_orders');
        }
        register_deactivation_hook(__FILE__, function () {
            wp_clear_scheduled_hook('pkx_pod_sync_orders');
        });

        add_action('add_meta_boxes', [__CLASS__, 'add_order_meta_box']);
    }

    // ------------------------------------------------------------ API client

    private static function api_base() {
        return rtrim(get_option(self::OPT_API_BASE, 'https://bambu-print-farm-automation.vercel.app'), '/');
    }

    private static function api_request($method, $path, $body = null) {
        $key = get_option(self::OPT_API_KEY, '');
        if (!$key) {
            return new WP_Error('pkx_no_key', 'PrintKinetix API key is not configured (Settings → PrintKinetix).');
        }
        $args = [
            'method'  => $method,
            'timeout' => 45,
            'headers' => [
                'Authorization' => 'Bearer ' . $key,
                'Content-Type'  => 'application/json',
            ],
        ];
        if ($body !== null) {
            $args['body'] = wp_json_encode($body);
        }
        $response = wp_remote_request(self::api_base() . $path, $args);
        if (is_wp_error($response)) {
            return $response;
        }
        $code = wp_remote_retrieve_response_code($response);
        $json = json_decode(wp_remote_retrieve_body($response), true);
        if ($code >= 400 || (is_array($json) && isset($json['ok']) && $json['ok'] === false)) {
            $message = is_array($json) ? ($json['message'] ?? $json['error'] ?? "HTTP $code") : "HTTP $code";
            return new WP_Error('pkx_api_error', "PrintKinetix API: $message");
        }
        return is_array($json) ? $json : [];
    }

    // -------------------------------------------------------------- settings

    public static function admin_menu() {
        add_options_page('PrintKinetix', 'PrintKinetix', 'manage_options', 'pkx-pod', [__CLASS__, 'render_settings_page']);
    }

    public static function register_settings() {
        register_setting(self::OPTION_GROUP, self::OPT_API_BASE, ['sanitize_callback' => 'esc_url_raw']);
        register_setting(self::OPTION_GROUP, self::OPT_API_KEY, ['sanitize_callback' => 'sanitize_text_field']);
    }

    public static function render_settings_page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        $connection = null;
        if (isset($_GET['pkx_test'])) {
            $result = self::api_request('GET', '/api/public/farm/capabilities');
            $connection = is_wp_error($result)
                ? ['ok' => false, 'message' => $result->get_error_message()]
                : ['ok' => true, 'message' => 'Connected — the farm is reachable with this key.'];
        }
        ?>
        <div class="wrap">
            <h1>PrintKinetix Print-on-Demand</h1>
            <p>Link this store to your PrintKinetix merchant account. Get an API key (<code>pkx_live_…</code>) from your merchant portal.</p>
            <?php if ($connection) : ?>
                <div class="notice <?php echo $connection['ok'] ? 'notice-success' : 'notice-error'; ?>"><p><?php echo esc_html($connection['message']); ?></p></div>
            <?php endif; ?>
            <form method="post" action="options.php">
                <?php settings_fields(self::OPTION_GROUP); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="pkx_api_base_url">Farm cloud URL</label></th>
                        <td><input name="<?php echo esc_attr(self::OPT_API_BASE); ?>" id="pkx_api_base_url" type="url" class="regular-text"
                            value="<?php echo esc_attr(get_option(self::OPT_API_BASE, 'https://bambu-print-farm-automation.vercel.app')); ?>"></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="pkx_api_key">Merchant API key</label></th>
                        <td><input name="<?php echo esc_attr(self::OPT_API_KEY); ?>" id="pkx_api_key" type="password" class="regular-text"
                            value="<?php echo esc_attr(get_option(self::OPT_API_KEY, '')); ?>" autocomplete="new-password">
                            <p class="description">Created in the PrintKinetix merchant portal (API keys).</p></td>
                    </tr>
                </table>
                <?php submit_button('Save settings'); ?>
            </form>
            <p><a class="button" href="<?php echo esc_url(admin_url('options-general.php?page=pkx-pod&pkx_test=1')); ?>">Test connection</a></p>
            <h2>How it works</h2>
            <ol>
                <li>Edit any WooCommerce product and attach a 3D model in the <strong>PrintKinetix 3D Printing</strong> box — the file uploads to the farm and the product becomes print-on-demand.</li>
                <li>Customers pick color, size, strength, and quality on the product page (with an interactive 3D preview when you provide a preview file).</li>
                <li>When an order is paid, this plugin sends it to the farm with the customer's shipping address. The farm prints and ships automatically; order status syncs back hourly.</li>
            </ol>
        </div>
        <?php
    }

    // ------------------------------------------------- product admin (model)

    public static function add_product_meta_box() {
        add_meta_box('pkx-pod-product', 'PrintKinetix 3D Printing', [__CLASS__, 'render_product_meta_box'], 'product', 'side');
    }

    public static function render_product_meta_box($post) {
        wp_nonce_field('pkx_pod_product', 'pkx_pod_nonce');
        $file_id = get_post_meta($post->ID, self::META_FILE_ID, true);
        $file_name = get_post_meta($post->ID, self::META_FILE_NAME, true);
        $preview = get_post_meta($post->ID, self::META_PREVIEW_URL, true);
        $materials = get_post_meta($post->ID, self::META_MATERIALS, true) ?: 'PLA,PETG';
        ?>
        <p><strong>Model on the farm:</strong><br>
        <?php echo $file_id ? esc_html($file_name) . ' <code>' . esc_html(substr($file_id, 0, 8)) . '…</code>' : 'No model attached yet.'; ?></p>
        <p><label>Upload model (STL/3MF/STEP/OBJ/G-code, ≤25&nbsp;MB)<br>
            <input type="file" name="pkx_model_file" accept=".stl,.3mf,.gcode,.obj,.step,.stp"></label></p>
        <p><label>3D preview file URL (optional, STL/OBJ from your Media Library — shown to customers)<br>
            <input type="url" name="pkx_preview_url" class="widefat" value="<?php echo esc_attr($preview); ?>"></label></p>
        <p><label>Offered materials (comma separated)<br>
            <input type="text" name="pkx_materials" class="widefat" value="<?php echo esc_attr($materials); ?>"></label></p>
        <p class="description">Attaching a model uploads it to your PrintKinetix farm and turns this product into an auto-printed item.</p>
        <?php
    }

    public static function save_product_meta($post_id, $post) {
        if (!isset($_POST['pkx_pod_nonce']) || !wp_verify_nonce($_POST['pkx_pod_nonce'], 'pkx_pod_product')) {
            return;
        }
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
            return;
        }
        if (!current_user_can('edit_post', $post_id)) {
            return;
        }

        if (isset($_POST['pkx_preview_url'])) {
            update_post_meta($post_id, self::META_PREVIEW_URL, esc_url_raw(wp_unslash($_POST['pkx_preview_url'])));
        }
        if (isset($_POST['pkx_materials'])) {
            update_post_meta($post_id, self::META_MATERIALS, sanitize_text_field(wp_unslash($_POST['pkx_materials'])));
        }

        if (!empty($_FILES['pkx_model_file']['tmp_name']) && is_uploaded_file($_FILES['pkx_model_file']['tmp_name'])) {
            $name = sanitize_file_name($_FILES['pkx_model_file']['name']);
            $bytes = file_get_contents($_FILES['pkx_model_file']['tmp_name']);
            if ($bytes !== false && strlen($bytes) <= 25 * 1024 * 1024) {
                $result = self::api_request('POST', '/api/public/files', [
                    'file' => [
                        'name' => $name,
                        'base64' => base64_encode($bytes),
                    ],
                ]);
                if (!is_wp_error($result)) {
                    $file = $result['data'] ?? $result['file'] ?? $result;
                    $file_id = $file['file_id'] ?? null;
                    if ($file_id) {
                        update_post_meta($post_id, self::META_FILE_ID, sanitize_text_field($file_id));
                        update_post_meta($post_id, self::META_FILE_NAME, $name);
                    }
                } else {
                    set_transient('pkx_pod_error_' . $post_id, $result->get_error_message(), 60);
                }
            }
        }
    }

    // -------------------------------------------------- customer customizer

    public static function enqueue_assets() {
        if (!function_exists('is_product') || !is_product()) {
            return;
        }
        $product_id = get_queried_object_id();
        if (!get_post_meta($product_id, self::META_FILE_ID, true)) {
            return;
        }
        $base = plugin_dir_url(__FILE__) . 'assets/';
        wp_enqueue_script('pkx-model-viewer', $base . 'pkx-model-viewer.js', [], '1.0.0', true);
        wp_enqueue_script('pkx-customizer', $base . 'pkx-customizer.js', ['pkx-model-viewer'], '1.0.0', true);
        wp_localize_script('pkx-customizer', 'pkxPodConfig', [
            'previewUrl' => get_post_meta($product_id, self::META_PREVIEW_URL, true) ?: null,
            'materials'  => array_values(array_filter(array_map('trim', explode(',', get_post_meta($product_id, self::META_MATERIALS, true) ?: 'PLA,PETG')))),
        ]);
    }

    public static function render_customizer() {
        global $product;
        if (!$product || !get_post_meta($product->get_id(), self::META_FILE_ID, true)) {
            return;
        }
        // The JS builds the controls (and 3D preview) inside this container and
        // keeps the hidden inputs in sync so the choices ride the cart item.
        ?>
        <div id="pkx-customizer" data-pkx="1">
            <input type="hidden" name="pkx_material" value="PLA">
            <input type="hidden" name="pkx_color" value="">
            <input type="hidden" name="pkx_scale" value="100">
            <input type="hidden" name="pkx_infill" value="standard">
            <input type="hidden" name="pkx_quality" value="standard">
        </div>
        <?php
    }

    public static function capture_cart_item_data($cart_item_data, $product_id) {
        if (!get_post_meta($product_id, self::META_FILE_ID, true)) {
            return $cart_item_data;
        }
        $finish = [
            'material' => isset($_POST['pkx_material']) ? sanitize_text_field(wp_unslash($_POST['pkx_material'])) : 'PLA',
            'color'    => isset($_POST['pkx_color']) ? sanitize_text_field(wp_unslash($_POST['pkx_color'])) : '',
            'scale'    => isset($_POST['pkx_scale']) ? max(25, min(400, intval($_POST['pkx_scale']))) : 100,
            'infill'   => isset($_POST['pkx_infill']) ? sanitize_text_field(wp_unslash($_POST['pkx_infill'])) : 'standard',
            'quality'  => isset($_POST['pkx_quality']) ? sanitize_text_field(wp_unslash($_POST['pkx_quality'])) : 'standard',
        ];
        $cart_item_data['pkx_finish'] = $finish;
        return $cart_item_data;
    }

    public static function display_cart_item_data($item_data, $cart_item) {
        if (empty($cart_item['pkx_finish'])) {
            return $item_data;
        }
        $finish = $cart_item['pkx_finish'];
        $item_data[] = ['key' => 'Material', 'value' => $finish['material']];
        if (!empty($finish['color'])) {
            $item_data[] = ['key' => 'Color', 'value' => $finish['color']];
        }
        if (intval($finish['scale']) !== 100) {
            $item_data[] = ['key' => 'Size', 'value' => $finish['scale'] . '%'];
        }
        $item_data[] = ['key' => 'Strength', 'value' => $finish['infill']];
        $item_data[] = ['key' => 'Quality', 'value' => $finish['quality']];
        return $item_data;
    }

    public static function save_order_item_meta($item, $cart_item_key, $values, $order) {
        if (!empty($values['pkx_finish'])) {
            $item->add_meta_data('_pkx_finish', $values['pkx_finish'], true);
        }
    }

    // ----------------------------------------------- order -> farm submission

    public static function submit_order_to_farm($order_id) {
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta(self::META_ORDER_ID)) {
            return; // already submitted (idempotent across processing+completed hooks)
        }

        $items = [];
        foreach ($order->get_items() as $item_id => $item) {
            $product = $item->get_product();
            if (!$product) {
                continue;
            }
            $file_id = get_post_meta($product->get_id(), self::META_FILE_ID, true);
            if (!$file_id) {
                continue;
            }
            $finish = $item->get_meta('_pkx_finish') ?: [];
            $requirements = ['material' => $finish['material'] ?? 'PLA'];
            if (!empty($finish['color'])) {
                $requirements['colors'] = [$finish['color']];
            }
            $items[] = [
                'file_id' => $file_id,
                'sku' => $product->get_sku() ?: ('woo-' . $product->get_id()),
                'name' => $item->get_name(),
                'quantity' => max(1, intval($item->get_quantity())),
                'requirements' => $requirements,
                'auto_submit' => true,
                'metadata' => [
                    'source' => 'woocommerce',
                    'woo_order_id' => $order_id,
                    'woo_item_id' => $item_id,
                    'finish' => $finish,
                ],
            ];
        }
        if (empty($items)) {
            return; // no print-on-demand items in this order
        }

        $shipping = [
            'line1' => $order->get_shipping_address_1() ?: $order->get_billing_address_1(),
            'line2' => $order->get_shipping_address_2() ?: $order->get_billing_address_2(),
            'city' => $order->get_shipping_city() ?: $order->get_billing_city(),
            'region' => $order->get_shipping_state() ?: $order->get_billing_state(),
            'postal_code' => $order->get_shipping_postcode() ?: $order->get_billing_postcode(),
            'country' => $order->get_shipping_country() ?: $order->get_billing_country(),
        ];

        $result = self::api_request('POST', '/api/public/orders', [
            'external_order_id' => 'woo-' . preg_replace('/[^a-z0-9]/i', '', wp_parse_url(home_url(), PHP_URL_HOST)) . '-' . $order_id,
            'auto_submit' => true,
            'customer' => [
                'name' => trim($order->get_formatted_billing_full_name()),
                'email' => $order->get_billing_email(),
            ],
            'shipping_address' => $shipping,
            'items' => $items,
            'metadata' => ['source' => 'woocommerce', 'woo_order_id' => $order_id],
        ]);

        if (is_wp_error($result)) {
            $order->add_order_note('PrintKinetix submission failed: ' . $result->get_error_message() . ' — will NOT retry automatically; resubmit by re-saving the order status.');
            return;
        }
        $farm_order = $result['data'] ?? $result['order'] ?? $result;
        $farm_order_id = $farm_order['order_id'] ?? null;
        if ($farm_order_id) {
            $order->update_meta_data(self::META_ORDER_ID, $farm_order_id);
            $order->update_meta_data(self::META_ORDER_STATUS, $farm_order['status'] ?? 'submitted');
            $order->save();
            $order->add_order_note('Sent to PrintKinetix farm for printing (order ' . $farm_order_id . '). The farm prints and ships automatically.');
        }
    }

    // ------------------------------------------------ farm -> Woo status sync

    public static function sync_farm_orders() {
        $orders = wc_get_orders([
            'limit' => 25,
            'meta_key' => self::META_ORDER_ID,
            'status' => ['wc-processing', 'wc-completed'],
        ]);
        foreach ($orders as $order) {
            $farm_order_id = $order->get_meta(self::META_ORDER_ID);
            $last_status = $order->get_meta(self::META_ORDER_STATUS);
            if (!$farm_order_id || in_array($last_status, ['completed', 'shipped'], true)) {
                continue;
            }
            $result = self::api_request('GET', '/api/public/orders/' . rawurlencode($farm_order_id));
            if (is_wp_error($result)) {
                continue;
            }
            $farm_order = $result['data'] ?? $result['order'] ?? $result;
            $status = $farm_order['status'] ?? null;
            if ($status && $status !== $last_status) {
                $order->update_meta_data(self::META_ORDER_STATUS, $status);
                $order->save();
                $order->add_order_note('PrintKinetix farm status: ' . $status);
            }
        }
    }

    public static function add_order_meta_box() {
        $screen = class_exists(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)
            && wc_get_container()->get(\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController::class)->custom_orders_table_usage_is_enabled()
            ? wc_get_page_screen_id('shop-order')
            : 'shop_order';
        add_meta_box('pkx-pod-order', 'PrintKinetix Farm', function ($post_or_order) {
            $order = $post_or_order instanceof WC_Order ? $post_or_order : wc_get_order($post_or_order->ID);
            if (!$order) {
                return;
            }
            $farm_order_id = $order->get_meta(self::META_ORDER_ID);
            if (!$farm_order_id) {
                echo '<p>Not a print-on-demand order (or not submitted yet).</p>';
                return;
            }
            echo '<p><strong>Farm order:</strong> <code>' . esc_html($farm_order_id) . '</code><br>';
            echo '<strong>Status:</strong> ' . esc_html($order->get_meta(self::META_ORDER_STATUS) ?: 'submitted') . '</p>';
            echo '<p class="description">Status refreshes hourly; the farm prints, ships, and updates automatically.</p>';
        }, $screen, 'side');
    }
}

add_action('plugins_loaded', function () {
    if (class_exists('WooCommerce')) {
        PrintKinetix_POD::init();
    } else {
        add_action('admin_notices', function () {
            echo '<div class="notice notice-error"><p>PrintKinetix Print-on-Demand requires WooCommerce.</p></div>';
        });
    }
});
