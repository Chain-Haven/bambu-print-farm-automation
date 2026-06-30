// Simple Keychain Generator

parameters = [
    ["text", "MyName"],
    ["size", 10] // Font size
];

module keychain(text_string, font_size) {
    difference() {
        // Base plate
        union() {
            color("red")
            linear_extrude(height = 2)
            offset(r = 2)
            text(text_string, size = font_size, valign = "center", halign = "center");
            
            // Ring hole tab
            translate([-len(text_string)*font_size/2.5 - 5, 0, 0])
            cylinder(h=2, r=5);
        }
        
        // Ring hole
        translate([-len(text_string)*font_size/2.5 - 5, 0, -1])
        cylinder(h=4, r=2);
        
        // Recessed text (optional style) or Raised text (below)
    }
    
    // Raised Text
    color("white")
    translate([0, 0, 2])
    linear_extrude(height = 1)
    text(text_string, size = font_size, valign = "center", halign = "center");
}

// Render
keychain(text, 10);
