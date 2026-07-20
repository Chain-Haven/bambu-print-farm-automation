=== PrintKinetix Print-on-Demand ===
Contributors: printkinetix
Tags: 3d printing, print on demand, woocommerce
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: MIT

Sell 3D-printed products from your WooCommerce store. Attach a 3D model to any
product; customers customize color, size, strength, and surface quality (with
an interactive 3D preview); paid orders are automatically printed and shipped
by your PrintKinetix farm.

== Installation ==

1. In WordPress: Plugins → Add New → Upload Plugin → choose this ZIP → Activate.
2. Settings → PrintKinetix: paste your farm cloud URL and your merchant API key
   (create one in the PrintKinetix merchant portal), then Test connection.
3. Edit a product → "PrintKinetix 3D Printing" box → upload the 3D model
   (STL/3MF/STEP/OBJ/G-code). Optionally add a preview STL/OBJ URL from your
   Media Library for the interactive on-page 3D viewer, and list the materials
   you offer.
4. Done. When customers pay, the order (with their shipping address and their
   customization choices) is sent to the farm, printed automatically, and the
   status syncs back to the WooCommerce order hourly.

== Frequently Asked Questions ==

= Where does billing happen? =
In your store, with your prices and your payment gateway. The farm bills you
per the merchant agreement — your margin is yours.

= What do customers customize? =
Material, color (routed to a printer with that filament loaded), size
(50–200%), strength (infill), and surface quality (layer height).

= What happens on failures? =
The farm auto-retries failed prints once and alerts the operator. Order notes
in WooCommerce record every submission and status change.
